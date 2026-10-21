// Подсказки о совместном использовании аккаунтов («шаринге») — ТОЛЬКО для показа администратору.
//
// * Сервер по этим подсказкам ничего не делает сам: не блокирует, не фильтрует, не завершает сессии,
//   не предупреждает пользователей и не меняет их данные. Журналы пишутся всегда, а оценка считается,
//   только когда администратор включил переключатель и открыл список (по запросу, только чтение,
//   с ограничением объёма; результат держится в памяти несколько минут).
// * GeoIP — локальная база geoip-lite (без внешних сервисов). Она занимает ~110 МБ памяти, поэтому
//   загружается только при первом анализе.
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { sharingConfig } from './sharingConfig.js';

const require = createRequire(import.meta.url);
let geoModule = null;
const geoip = () => (geoModule ??= require('geoip-lite'));

const SETTING_KEY = 'sharing_hints';
const DAY_MS = 24 * 60 * 60_000;

/** Подсеть адреса: /24 для IPv4, /48 для IPv6. */
export function subnetOf(ip) {
  if (!ip) return null;
  const clean = String(ip).replace(/\/\d+$/, '');
  const family = isIP(clean);
  if (family === 4) return `${clean.split('.').slice(0, 3).join('.')}.0/24`;
  if (family === 6) {
    const groups = clean.split('::')[0].split(':');
    return `${[...groups, '0', '0', '0'].slice(0, 3).join(':')}::/48`;
  }
  return null;
}

function haversineKm([lat1, lon1], [lat2, lon2]) {
  const rad = Math.PI / 180;
  const dLat = (lat2 - lat1) * rad;
  const dLon = (lon2 - lon1) * rad;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(lat1 * rad) * Math.cos(lat2 * rad) * Math.sin(dLon / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(a));
}

/** Местоположение IP по локальной базе: { country, city, ll } или null. */
export function defaultGeoLookup() {
  const cache = new Map();
  return (ip) => {
    if (!ip) return null;
    const clean = String(ip).replace(/\/\d+$/, '');
    if (!cache.has(clean)) {
      const found = geoip().lookup(clean);
      cache.set(clean, found ? { country: found.country || null, city: found.city || null, ll: found.ll ?? null } : null);
    }
    return cache.get(clean);
  };
}

const osFamily = (os) => (os ? os.replace(/\s+[\d.]+$/, '') : null);
const place = (geo) => (geo ? [geo.city, geo.country].filter(Boolean).join(', ') : 'неизвестно');
const fmtMinutes = (ms) => (ms < 60 * 60_000 ? `${Math.max(1, Math.round(ms / 60_000))} мин` : `${Math.round(ms / (60 * 60_000))} ч`);

function hourIn(date, timeZone) {
  return Number(new Intl.DateTimeFormat('en-GB', { hour: '2-digit', hour12: false, timeZone }).format(date)) % 24;
}

// Средний час с учётом того, что 23:00 и 01:00 рядом.
function meanHour(hours) {
  const angles = hours.map((hour) => (hour / 24) * 2 * Math.PI);
  const x = angles.reduce((sum, a) => sum + Math.cos(a), 0);
  const y = angles.reduce((sum, a) => sum + Math.sin(a), 0);
  const angle = Math.atan2(y, x);
  return (((angle / (2 * Math.PI)) * 24) + 24) % 24;
}

const hourGap = (a, b) => {
  const diff = Math.abs(a - b) % 24;
  return Math.min(diff, 24 - diff);
};

/**
 * Оценка одного аккаунта.
 * events: [{ visitorId, type, ip, deviceType, os, browser, createdAt: Date, anonymized }]
 * sessions: [{ visitorId, ip, createdAt: Date, lastSeenAt: Date, validUntil: Date }] — validUntil: отзыв или истечение
 * Возвращает { score, level, reasons: [{ signal, weight, text }] }.
 */
export function analyzeAccount({ events, sessions }, config, { geoLookup, now = Date.now(), timeZone = 'Europe/Moscow' }) {
  const reasons = [];
  const add = (signal, weight, text) => reasons.push({ signal, weight: Math.round(weight), text });

  // 1. Одновременные сессии с разных устройств и подсетей.
  {
    let best = null;
    const list = sessions.filter((s) => s.visitorId && s.ip);
    const window = config.concurrent.windowMinutes * 60_000;
    const validAt = (session, time) => time >= session.createdAt && time <= (session.validUntil ?? session.lastSeenAt);
    // Позднее из двух использований случилось, пока обе сессии действовали, а между ними не больше окна.
    const usedTogether = (a, b) => [a.createdAt, a.lastSeenAt].some((ta) => [b.createdAt, b.lastSeenAt].some((tb) => {
      if (Math.abs(ta - tb) > window) return false;
      const later = Math.max(ta, tb);
      return validAt(a, later) && validAt(b, later);
    }));
    for (let i = 0; i < list.length; i += 1) {
      for (let j = i + 1; j < list.length; j += 1) {
        const a = list[i];
        const b = list[j];
        if (a.visitorId === b.visitorId) continue;
        const subnetA = subnetOf(a.ip);
        const subnetB = subnetOf(b.ip);
        if (!subnetA || subnetA === subnetB) continue; // та же /24 — скорее всего одна сеть, не считаем
        if (!usedTogether(a, b)) continue;
        const geoA = geoLookup(a.ip);
        const geoB = geoLookup(b.ip);
        const sameCity = geoA?.city && geoB?.city && geoA.city === geoB.city && geoA.country === geoB.country;
        const weight = config.concurrent.weight * (sameCity ? config.concurrent.sameCityFactor : 1);
        if (!best || weight > best.weight) best = { weight, subnetA, subnetB, geoA, geoB, sameCity };
      }
    }
    if (best) {
      add('concurrent', best.weight, best.sameCity
        ? `Одновременные сессии с разных устройств и сетей одного города (${place(best.geoA)}): ${best.subnetA} и ${best.subnetB}`
        : `Одновременные сессии с разных устройств и сетей: ${best.subnetA} (${place(best.geoA)}) и ${best.subnetB} (${place(best.geoB)})`);
    }
  }

  const located = events
    .filter((e) => e.ip && !e.anonymized)
    .map((e) => ({ ...e, subnet: subnetOf(e.ip) }))
    .sort((a, b) => a.createdAt - b.createdAt);

  // 2. Смена города или страны быстрее, чем можно доехать.
  {
    let found = null;
    for (let i = 1; i < located.length && !found; i += 1) {
      const prev = located[i - 1];
      const next = located[i];
      if (prev.subnet === next.subnet) continue;
      const geoA = geoLookup(prev.ip);
      const geoB = geoLookup(next.ip);
      if (!geoA || !geoB) continue;
      const dt = next.createdAt - prev.createdAt;
      if (geoA.city && geoB.city && geoA.ll && geoB.ll) {
        if (geoA.city === geoB.city && geoA.country === geoB.country) continue; // тот же город — не прыжок
        const km = haversineKm(geoA.ll, geoB.ll);
        const speed = km / Math.max(dt / 3_600_000, 1 / 60);
        if (km >= config.geoJump.minDistanceKm && speed > config.geoJump.maxSpeedKmh) {
          found = `${place(geoA)} → ${place(geoB)} за ${fmtMinutes(dt)} (≈${Math.round(km)} км)`;
        }
      } else if (geoA.country && geoB.country && geoA.country !== geoB.country && dt < 2 * 60 * 60_000) {
        found = `${geoA.country} → ${geoB.country} за ${fmtMinutes(dt)}`;
      }
    }
    if (found) add('geoJump', config.geoJump.weight, `Слишком быстрая смена места: ${found}`);
  }

  // 3. Много разных устройств за последние дни.
  {
    const since = now - config.manyDevices.days * DAY_MS;
    const devices = new Set([
      ...events.filter((e) => e.visitorId && e.createdAt >= since).map((e) => e.visitorId),
      ...sessions.filter((s) => s.visitorId && s.lastSeenAt >= since).map((s) => s.visitorId),
    ]);
    if (devices.size > config.manyDevices.limit) {
      add('manyDevices', config.manyDevices.weight, `${devices.size} разных устройств за ${config.manyDevices.days} дн (обычно не больше ${config.manyDevices.limit})`);
    }
  }

  // 4. Игры, запущенные почти одновременно с разных устройств.
  {
    const rooms = events.filter((e) => e.type === 'room_create' && e.visitorId).sort((a, b) => a.createdAt - b.createdAt);
    let found = null;
    for (let i = 0; i < rooms.length && !found; i += 1) {
      for (let j = i + 1; j < rooms.length; j += 1) {
        const gap = rooms[j].createdAt - rooms[i].createdAt;
        if (gap > config.parallelGames.minutes * 60_000) break;
        if (rooms[j].visitorId !== rooms[i].visitorId) {
          found = `комнаты ${rooms[i].roomCode ?? '—'} и ${rooms[j].roomCode ?? '—'} с разницей ${fmtMinutes(gap)}`;
          break;
        }
      }
    }
    if (found) add('parallelGames', config.parallelGames.weight, `Две игры одновременно с разных устройств: ${found}`);
  }

  // 5. Разные ОС в один день без основного устройства.
  {
    const byDay = new Map();
    const perVisitor = new Map();
    for (const e of events) {
      const day = e.createdAt.toISOString().slice(0, 10);
      if (!byDay.has(day)) byDay.set(day, new Set());
      const family = osFamily(e.os);
      if (family) byDay.get(day).add(family);
      if (e.visitorId) perVisitor.set(e.visitorId, (perVisitor.get(e.visitorId) ?? 0) + 1);
    }
    const mixedDays = [...byDay.values()].filter((families) => families.size >= 2).length;
    const total = [...perVisitor.values()].reduce((sum, count) => sum + count, 0);
    const mainShare = total ? Math.max(...perVisitor.values()) / total : 1;
    if (mixedDays >= config.mixedDevices.minDays && mainShare < config.mixedDevices.mainShare) {
      add('mixedDevices', config.mixedDevices.weight, `Разные ОС в один день — ${mixedDays} дн; основного устройства нет (самое частое — ${Math.round(mainShare * 100)}% входов)`);
    }
  }

  // 6. Устройства чередуются по времени суток.
  {
    const byVisitor = new Map();
    for (const e of events) {
      if (!e.visitorId) continue;
      if (!byVisitor.has(e.visitorId)) byVisitor.set(e.visitorId, { days: new Set(), hours: [], first: e.createdAt, last: e.createdAt });
      const item = byVisitor.get(e.visitorId);
      item.days.add(e.createdAt.toISOString().slice(0, 10));
      item.hours.push(hourIn(e.createdAt, timeZone));
      if (e.createdAt < item.first) item.first = e.createdAt;
      if (e.createdAt > item.last) item.last = e.createdAt;
    }
    const regular = [...byVisitor.values()].filter((item) => item.days.size >= config.alternation.minDaysEach);
    let found = null;
    for (let i = 0; i < regular.length && !found; i += 1) {
      for (let j = i + 1; j < regular.length; j += 1) {
        const a = regular[i];
        const b = regular[j];
        const overlap = Math.min(a.last, b.last) - Math.max(a.first, b.first);
        const ha = meanHour(a.hours);
        const hb = meanHour(b.hours);
        if (overlap > 0 && hourGap(ha, hb) >= config.alternation.hourGap) {
          found = `одно в среднем около ${Math.round(ha) % 24}:00, другое около ${Math.round(hb) % 24}:00`;
          break;
        }
      }
    }
    if (found) add('alternation', config.alternation.weight, `Устройства регулярно чередуются по времени суток: ${found}`);
  }

  const score = Math.min(100, reasons.reduce((sum, reason) => sum + reason.weight, 0));
  const level = score >= config.thresholds.red ? 'red' : score >= config.thresholds.yellow ? 'yellow' : 'green';
  return { score, level, reasons };
}

export class SharingService {
  #enabled = null;
  #enabledAt = 0;
  #cache = null;
  #running = null;

  constructor(db, { config = sharingConfig(), timeZone = 'Europe/Moscow', geoLookupFactory = defaultGeoLookup } = {}) {
    this.db = db;
    this.config = config;
    this.timeZone = timeZone;
    this.geoLookupFactory = geoLookupFactory;
  }

  async enabled() {
    if (this.#enabled !== null && Date.now() - this.#enabledAt < 5_000) return this.#enabled;
    const row = await this.db.one('SELECT value FROM settings WHERE key = $1', [SETTING_KEY]);
    this.#enabled = row?.value?.enabled === true;
    this.#enabledAt = Date.now();
    return this.#enabled;
  }

  async setEnabled(enabled, admin, runner = this.db) {
    await runner.query(
      `INSERT INTO settings (key, value, updated_by) VALUES ($1, $2, $3)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now(), updated_by = EXCLUDED.updated_by`,
      [SETTING_KEY, { enabled: Boolean(enabled) }, admin?.id ?? null],
    );
    this.#enabled = null;
    this.clear();
  }

  clear() {
    this.#cache = null;
  }

  async hiddenIds() {
    return new Set((await this.db.many('SELECT account_id FROM sharing_hidden')).map((row) => row.account_id));
  }

  async setHidden(accountId, hidden, admin, runner = this.db) {
    if (hidden) {
      await runner.query(
        `INSERT INTO sharing_hidden (account_id, hidden_by, hidden_by_login) VALUES ($1, $2, $3)
         ON CONFLICT (account_id) DO UPDATE SET hidden_by = EXCLUDED.hidden_by, hidden_by_login = EXCLUDED.hidden_by_login, hidden_at = now()`,
        [accountId, admin?.id ?? null, admin?.login ?? null],
      );
    } else {
      await runner.query('DELETE FROM sharing_hidden WHERE account_id = $1', [accountId]);
    }
  }

  /**
   * Анализ всех аккаунтов, активных за окно (по запросу администратора). Результат кэшируется на cacheMinutes.
   * Возвращает { computedAt, durationMs, analyzed, limited, results: Map(accountId → { score, level, reasons }) }.
   * Если подсказки выключены — null (и ничего не считается).
   */
  async analysis({ force = false } = {}) {
    if (!(await this.enabled())) return null;
    const fresh = this.#cache && Date.now() - this.#cache.computedAtMs < this.config.cacheMinutes * 60_000;
    if (fresh && !force) return this.#cache;
    this.#running ??= this.#compute().finally(() => {
      this.#running = null;
    });
    this.#cache = await this.#running;
    return this.#cache;
  }

  async #compute() {
    const started = Date.now();
    const { windowDays, maxAccounts, maxEventsPerAccount, maxSessionsPerAccount } = this.config;
    const candidates = await this.db.many(
      `SELECT a.id FROM accounts a
        WHERE a.role = 'user'
          AND EXISTS (SELECT 1 FROM events e WHERE e.account_id = a.id AND e.created_at > now() - make_interval(days => $1))
        ORDER BY a.last_login_at DESC NULLS LAST LIMIT $2`,
      [windowDays, maxAccounts + 1],
    );
    const limited = candidates.length > maxAccounts;
    const ids = candidates.slice(0, maxAccounts).map((row) => row.id);
    const results = new Map();
    if (ids.length) {
      const [events, sessions] = await Promise.all([
        this.db.many(
          `SELECT account_id, visitor_id, type, room_code, host(ip) AS ip, device_type, os, browser, created_at, anonymized_at IS NOT NULL AS anonymized
             FROM (SELECT e.*, row_number() OVER (PARTITION BY e.account_id ORDER BY e.created_at DESC) AS rn
                     FROM events e
                    WHERE e.account_id = ANY($1::uuid[]) AND e.created_at > now() - make_interval(days => $2)) x
            WHERE rn <= $3`,
          [ids, windowDays, maxEventsPerAccount],
        ),
        this.db.many(
          `SELECT account_id, visitor_id, host(ip) AS ip, created_at, last_seen_at,
                  COALESCE(revoked_at, LEAST(expires_at, absolute_expires_at)) AS valid_until
             FROM (SELECT s.*, row_number() OVER (PARTITION BY s.account_id ORDER BY s.last_seen_at DESC) AS rn
                     FROM sessions s
                    WHERE s.account_id = ANY($1::uuid[]) AND s.last_seen_at > now() - make_interval(days => $2)) x
            WHERE rn <= $3`,
          [ids, windowDays, maxSessionsPerAccount],
        ),
      ]);
      const group = (rows, map) => {
        const out = new Map();
        for (const row of rows) {
          if (!out.has(row.account_id)) out.set(row.account_id, []);
          out.get(row.account_id).push(map(row));
        }
        return out;
      };
      const eventsBy = group(events, (row) => ({
        visitorId: row.visitor_id,
        type: row.type,
        roomCode: row.room_code,
        ip: row.ip,
        deviceType: row.device_type,
        os: row.os,
        browser: row.browser,
        createdAt: new Date(row.created_at),
        anonymized: row.anonymized,
      }));
      const sessionsBy = group(sessions, (row) => ({
        visitorId: row.visitor_id,
        ip: row.ip,
        createdAt: new Date(row.created_at),
        lastSeenAt: new Date(row.last_seen_at),
        validUntil: new Date(row.valid_until),
      }));
      const geoLookup = this.geoLookupFactory();
      const now = Date.now();
      for (const id of ids) {
        results.set(id, analyzeAccount(
          { events: eventsBy.get(id) ?? [], sessions: sessionsBy.get(id) ?? [] },
          this.config,
          { geoLookup, now, timeZone: this.timeZone },
        ));
      }
    }
    const computedAtMs = Date.now();
    return { computedAt: new Date(computedAtMs).toISOString(), computedAtMs, durationMs: computedAtMs - started, analyzed: ids.length, limited, results };
  }
}
