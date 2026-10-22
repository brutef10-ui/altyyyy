// Запросы админ-консоли (только чтение). Подсчёты (COUNT DISTINCT) — на сервере, выдача — постранично.
// Пароли, коды и токены здесь не читаются вовсе.
import { notFound } from '../errors.js';
import { isUuid } from '../security/bans.js';

const PAGE = 50;

export function page(query) {
  const limit = Math.min(100, Math.max(1, Number.parseInt(query.limit, 10) || PAGE));
  const offset = Math.max(0, Math.min(1_000_000, Number.parseInt(query.offset, 10) || 0));
  return { limit, offset };
}

const likeEscape = (value) => value.replace(/[\\%_]/g, (char) => `\\${char}`);

// Поиск: по логину, нику и IP (IP — по началу адреса: «203.0.113» найдёт всю подсеть).
function searchTerms(raw) {
  const q = String(raw ?? '').trim().slice(0, 64);
  if (!q) return { text: '', ip: '' };
  const ipLike = /^[0-9a-f.:]+$/i.test(q) && (q.includes('.') || q.includes(':')) ? q.toLowerCase() : '';
  return { text: `%${likeEscape(q.toLowerCase())}%`, ip: ipLike ? `${likeEscape(ipLike)}%` : '' };
}

const ACTIVE_BAN = `lifted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())`;
const banColumns = (alias) => `${alias}.id AS ban_id, ${alias}.reason AS ban_reason, ${alias}.ends_at AS ban_ends_at`;
const banOf = (row) => (row.ban_id ? { id: row.ban_id, reason: row.ban_reason, endsAt: row.ban_ends_at, forever: row.ban_ends_at === null } : null);
const ip = (value) => (value ? String(value).replace(/\/(32|128)$/, '') : null);

export class AdminQueries {
  constructor(db) {
    this.db = db;
  }

  async overview() {
    return this.db.one(
      `SELECT
         (SELECT count(*)::int FROM accounts WHERE role = 'user') AS accounts,
         (SELECT count(*)::int FROM visitors v WHERE NOT EXISTS (SELECT 1 FROM visitor_accounts va WHERE va.visitor_id = v.id)
            AND EXISTS (SELECT 1 FROM events e WHERE e.visitor_id = v.id)) AS guests,
         (SELECT count(*)::int FROM bans WHERE ${ACTIVE_BAN}) AS active_bans,
         (SELECT count(*)::int FROM events WHERE created_at > now() - interval '24 hours') AS events_24h,
         (SELECT count(*)::int FROM events WHERE type = 'room_join' AND created_at > now() - interval '24 hours') AS joins_24h`,
    );
  }

  /**
   * Вкладка «Зарегистрированные». sort: last_login (по умолчанию) | created.
   * ids — только эти аккаунты и в этом порядке (фильтр «Подозрительные»: по убыванию оценки).
   */
  async accounts(query, { ids = null } = {}) {
    const { limit, offset } = page(query);
    const { text, ip: ipPattern } = searchTerms(query.q);
    let order = query.sort === 'created' ? 'a.created_at DESC' : 'a.last_login_at DESC NULLS LAST, a.created_at DESC';
    if (ids) order = 'array_position($5::uuid[], a.id)';
    const rows = await this.db.many(
      `SELECT a.id, a.login, a.role, a.created_at, a.last_login_at,
              host(last_ev.ip) AS last_ip, last_ev.device_type, last_ev.os, last_ev.browser,
              stats.ips_all, stats.ips_24h, stats.ips_7d, stats.devices_all, stats.devices_24h, stats.devices_7d,
              ${banColumns('ban')}
         FROM accounts a
         LEFT JOIN LATERAL (
           SELECT ip, device_type, os, browser FROM events WHERE account_id = a.id ORDER BY created_at DESC LIMIT 1
         ) last_ev ON true
         LEFT JOIN LATERAL (
           SELECT count(DISTINCT ip)::int AS ips_all,
                  (count(DISTINCT ip) FILTER (WHERE created_at > now() - interval '24 hours'))::int AS ips_24h,
                  (count(DISTINCT ip) FILTER (WHERE created_at > now() - interval '7 days'))::int AS ips_7d,
                  count(DISTINCT visitor_id)::int AS devices_all,
                  (count(DISTINCT visitor_id) FILTER (WHERE created_at > now() - interval '24 hours'))::int AS devices_24h,
                  (count(DISTINCT visitor_id) FILTER (WHERE created_at > now() - interval '7 days'))::int AS devices_7d
             FROM events WHERE account_id = a.id
         ) stats ON true
         LEFT JOIN LATERAL (
           SELECT id, reason, ends_at FROM bans WHERE account_id = a.id AND ${ACTIVE_BAN}
            ORDER BY ends_at DESC NULLS FIRST LIMIT 1
         ) ban ON true
        WHERE a.role <> 'admin'
          AND ($1 = '' OR a.login_normalized LIKE $1
               OR EXISTS (SELECT 1 FROM events e WHERE e.account_id = a.id AND lower(e.nickname) LIKE $1)
               OR ($2 <> '' AND EXISTS (SELECT 1 FROM events e WHERE e.account_id = a.id AND host(e.ip) LIKE $2)))
          ${ids ? 'AND a.id = ANY($5::uuid[])' : ''}
        ORDER BY ${order}
        LIMIT $3 OFFSET $4`,
      ids ? [text, ipPattern, limit + 1, offset, ids] : [text, ipPattern, limit + 1, offset],
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        login: row.login,
        role: row.role,
        createdAt: row.created_at,
        lastLoginAt: row.last_login_at,
        lastIp: row.last_ip,
        deviceType: row.device_type,
        os: row.os,
        browser: row.browser,
        ips: { all: row.ips_all, day: row.ips_24h, week: row.ips_7d },
        devices: { all: row.devices_all, day: row.devices_24h, week: row.devices_7d },
        ban: banOf(row),
      })),
      hasMore: rows.length > limit,
    };
  }

  /**
   * Вкладка «Незарегистрированные»: посетители без аккаунта, у которых есть хоть одно событие.
   * После регистрации или входа посетитель связывается с аккаунтом и отсюда пропадает.
   * sort: last_seen (по умолчанию) | first_seen.
   */
  async visitors(query) {
    const { limit, offset } = page(query);
    const { text, ip: ipPattern } = searchTerms(query.q);
    const order = query.sort === 'first_seen' ? 'v.first_seen_at DESC' : 'v.last_seen_at DESC';
    const rows = await this.db.many(
      `SELECT v.id, v.first_seen_at, v.last_seen_at,
              host(last_ev.ip) AS last_ip, last_ev.device_type, last_ev.os, last_ev.browser,
              agg.nicknames, agg.joins, ${banColumns('ban')}
         FROM visitors v
         JOIN LATERAL (
           SELECT (array_agg(DISTINCT nickname) FILTER (WHERE nickname IS NOT NULL))[1:5] AS nicknames,
                  (count(*) FILTER (WHERE type = 'room_join'))::int AS joins,
                  count(*) AS total
             FROM events WHERE visitor_id = v.id
         ) agg ON agg.total > 0
         LEFT JOIN LATERAL (
           SELECT ip, device_type, os, browser FROM events WHERE visitor_id = v.id ORDER BY created_at DESC LIMIT 1
         ) last_ev ON true
         LEFT JOIN LATERAL (
           SELECT id, reason, ends_at FROM bans WHERE visitor_id = v.id AND ${ACTIVE_BAN}
            ORDER BY ends_at DESC NULLS FIRST LIMIT 1
         ) ban ON true
        WHERE NOT EXISTS (SELECT 1 FROM visitor_accounts va WHERE va.visitor_id = v.id)
          AND ($1 = '' OR v.id::text LIKE $1
               OR EXISTS (SELECT 1 FROM events e WHERE e.visitor_id = v.id AND lower(e.nickname) LIKE $1)
               OR ($2 <> '' AND EXISTS (SELECT 1 FROM events e WHERE e.visitor_id = v.id AND host(e.ip) LIKE $2)))
        ORDER BY ${order}
        LIMIT $3 OFFSET $4`,
      [text, ipPattern, limit + 1, offset],
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        shortId: row.id.slice(0, 8),
        nicknames: row.nicknames ?? [],
        lastIp: row.last_ip,
        deviceType: row.device_type,
        os: row.os,
        browser: row.browser,
        firstSeenAt: row.first_seen_at,
        lastSeenAt: row.last_seen_at,
        joins: row.joins,
        ban: banOf(row),
      })),
      hasMore: rows.length > limit,
    };
  }

  // Сводки по набору событий: IP, устройства, ники.
  async #summaries(where, params) {
    const [ips, devices, nicknames] = await Promise.all([
      this.db.many(
        `SELECT ip::text AS ip, min(created_at) AS first_at, max(created_at) AS last_at, count(*)::int AS count
           FROM events WHERE ${where} AND ip IS NOT NULL GROUP BY ip ORDER BY last_at DESC LIMIT 200`,
        params,
      ),
      this.db.many(
        `SELECT device_type, os, browser, min(created_at) AS first_at, max(created_at) AS last_at, count(*)::int AS count
           FROM events WHERE ${where} GROUP BY device_type, os, browser ORDER BY last_at DESC LIMIT 100`,
        params,
      ),
      this.db.many(
        `SELECT nickname, min(created_at) AS first_at, max(created_at) AS last_at, count(*)::int AS count
           FROM events WHERE ${where} AND nickname IS NOT NULL GROUP BY nickname ORDER BY last_at DESC LIMIT 100`,
        params,
      ),
    ]);
    return {
      ips: ips.map((row) => ({ ip: ip(row.ip), firstAt: row.first_at, lastAt: row.last_at, count: row.count })),
      devices: devices.map((row) => ({ deviceType: row.device_type, os: row.os, browser: row.browser, firstAt: row.first_at, lastAt: row.last_at, count: row.count })),
      nicknames: nicknames.map((row) => ({ nickname: row.nickname, firstAt: row.first_at, lastAt: row.last_at, count: row.count })),
    };
  }

  async #bans(where, params) {
    const rows = await this.db.many(
      `SELECT b.id, b.account_id, b.visitor_id, b.ip::text AS ip, b.reason, b.starts_at, b.ends_at, b.created_by_login,
              b.lifted_at, b.lifted_by_login, b.lift_reason, (${ACTIVE_BAN.replace(/(lifted_at|starts_at|ends_at)/g, 'b.$1')}) AS active
         FROM bans b WHERE ${where} ORDER BY b.created_at DESC LIMIT 100`,
      params,
    );
    return rows.map((row) => ({
      id: row.id,
      accountId: row.account_id,
      visitorId: row.visitor_id,
      ip: ip(row.ip),
      reason: row.reason,
      startsAt: row.starts_at,
      endsAt: row.ends_at,
      forever: row.ends_at === null,
      createdBy: row.created_by_login,
      liftedAt: row.lifted_at,
      liftedBy: row.lifted_by_login,
      liftReason: row.lift_reason,
      status: row.lifted_at ? 'lifted' : row.active ? 'active' : 'expired',
    }));
  }

  /** Карточка аккаунта. */
  async account(id) {
    if (!isUuid(id)) throw notFound('Аккаунт не найден');
    const account = await this.db.one(
      `SELECT id, login, role, created_at, last_login_at, password_changed_at, backup_code_created_at,
              (SELECT count(*)::int FROM sessions s WHERE s.account_id = a.id AND s.revoked_at IS NULL
                 AND s.expires_at > now() AND s.absolute_expires_at > now()) AS active_sessions
         FROM accounts a WHERE id = $1`,
      [id],
    );
    if (!account) throw notFound('Аккаунт не найден');
    const linked = await this.db.many(
      `SELECT va.visitor_id, va.linked_at, va.last_used_at, v.first_seen_at, v.last_seen_at
         FROM visitor_accounts va JOIN visitors v ON v.id = va.visitor_id
        WHERE va.account_id = $1 ORDER BY va.last_used_at DESC`,
      [id],
    );
    const visitorIds = linked.map((row) => row.visitor_id);
    // События аккаунта и гостевая история его устройств (до входа в аккаунт).
    const where = '(account_id = $1 OR (account_id IS NULL AND visitor_id = ANY($2::uuid[])))';
    const [summaries, bans, games, rooms, codes, guestStats] = await Promise.all([
      this.#summaries(where, [id, visitorIds]),
      this.#bans('(b.account_id = $1 OR b.visitor_id = ANY($2::uuid[]))', [id, visitorIds]),
      this.db.many(
        `SELECT id, title, created_at, updated_at, jsonb_array_length(data->'questions') AS questions
           FROM quizzes WHERE account_id = $1 ORDER BY updated_at DESC LIMIT 200`,
        [id],
      ),
      this.db.many(
        `SELECT room_code, details->>'title' AS title, created_at FROM events
          WHERE account_id = $1 AND type = 'room_create' ORDER BY created_at DESC LIMIT 50`,
        [id],
      ),
      this.db.many(
        `SELECT created_at, expires_at, used_at, revoked_at, revoke_reason, attempts,
                (SELECT login FROM accounts WHERE id = rc.created_by) AS created_by
           FROM recovery_codes rc WHERE account_id = $1 ORDER BY created_at DESC LIMIT 20`,
        [id],
      ),
      this.db.one(
        `SELECT count(*)::int AS events, min(created_at) AS first_at
           FROM events WHERE account_id IS NULL AND visitor_id = ANY($1::uuid[]) AND created_at <= $2`,
        [visitorIds, account.created_at],
      ),
    ]);
    return {
      account: {
        id: account.id,
        login: account.login,
        role: account.role,
        createdAt: account.created_at,
        lastLoginAt: account.last_login_at,
        passwordChangedAt: account.password_changed_at,
        backupCodeCreatedAt: account.backup_code_created_at,
        activeSessions: account.active_sessions,
      },
      visitors: linked.map((row) => ({ id: row.visitor_id, shortId: row.visitor_id.slice(0, 8), linkedAt: row.linked_at, lastUsedAt: row.last_used_at, firstSeenAt: row.first_seen_at, lastSeenAt: row.last_seen_at })),
      beforeRegistration: { events: guestStats.events, firstAt: guestStats.first_at },
      ...summaries,
      bans,
      games: games.map((row) => ({ id: row.id, title: row.title, questions: row.questions, createdAt: row.created_at, updatedAt: row.updated_at })),
      rooms: rooms.map((row) => ({ code: row.room_code, title: row.title, createdAt: row.created_at })),
      recoveryCodes: codes.map((row) => ({
        createdAt: row.created_at,
        expiresAt: row.expires_at,
        createdBy: row.created_by,
        status: row.used_at ? 'used' : row.revoked_at ? `revoked:${row.revoke_reason ?? ''}` : new Date(row.expires_at) < new Date() ? 'expired' : 'active',
        attempts: row.attempts,
      })),
    };
  }

  /** Карточка посетителя (устройства). */
  async visitor(id) {
    if (!isUuid(id)) throw notFound('Посетитель не найден');
    const visitor = await this.db.one('SELECT id, first_seen_at, last_seen_at, host(last_ip) AS last_ip FROM visitors WHERE id = $1', [id]);
    if (!visitor) throw notFound('Посетитель не найден');
    const [summaries, bans, accounts, joins] = await Promise.all([
      this.#summaries('visitor_id = $1', [id]),
      this.#bans('b.visitor_id = $1', [id]),
      this.db.many(
        `SELECT a.id, a.login, va.linked_at FROM visitor_accounts va JOIN accounts a ON a.id = va.account_id
          WHERE va.visitor_id = $1 ORDER BY va.linked_at`,
        [id],
      ),
      this.db.one("SELECT count(*)::int AS n FROM events WHERE visitor_id = $1 AND type = 'room_join'", [id]),
    ]);
    return {
      visitor: { id: visitor.id, shortId: visitor.id.slice(0, 8), firstSeenAt: visitor.first_seen_at, lastSeenAt: visitor.last_seen_at, lastIp: visitor.last_ip, joins: joins.n },
      accounts: accounts.map((row) => ({ id: row.id, login: row.login, linkedAt: row.linked_at })),
      ...summaries,
      bans,
    };
  }

  /** Журнал событий аккаунта (с гостевой историей его устройств) или посетителя. Постранично от новых к старым. */
  async events(query) {
    const limit = Math.min(200, Math.max(1, Number.parseInt(query.limit, 10) || 100));
    const before = Number.parseInt(query.before, 10);
    const params = [];
    let where;
    if (query.accountId) {
      if (!isUuid(query.accountId)) throw notFound('Аккаунт не найден');
      params.push(query.accountId);
      where = `(e.account_id = $1 OR (e.account_id IS NULL AND e.visitor_id IN (SELECT visitor_id FROM visitor_accounts WHERE account_id = $1)))`;
    } else if (query.visitorId) {
      if (!isUuid(query.visitorId)) throw notFound('Посетитель не найден');
      params.push(query.visitorId);
      where = 'e.visitor_id = $1';
    } else {
      where = 'true';
    }
    if (Number.isSafeInteger(before)) {
      params.push(before);
      where += ` AND e.id < $${params.length}`;
    }
    params.push(limit + 1);
    const rows = await this.db.many(
      `SELECT e.id, e.type, e.visitor_id, e.account_id, e.account_login, e.nickname, e.room_code, e.details,
              e.ip::text AS ip, e.device_type, e.os, e.browser, e.created_at, e.anonymized_at
         FROM events e WHERE ${where} ORDER BY e.id DESC LIMIT $${params.length}`,
      params,
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        type: row.type,
        visitorId: row.visitor_id,
        accountId: row.account_id,
        accountLogin: row.account_login,
        nickname: row.nickname,
        roomCode: row.room_code,
        details: row.details,
        ip: ip(row.ip),
        deviceType: row.device_type,
        os: row.os,
        browser: row.browser,
        createdAt: row.created_at,
        anonymized: Boolean(row.anonymized_at),
      })),
      hasMore: rows.length > limit,
      nextBefore: rows.length > limit ? rows[limit - 1].id : null,
    };
  }

  async audit(query) {
    const { limit, offset } = page(query);
    const rows = await this.db.many(
      `SELECT id, admin_login, action, target_type, target_id, details, ip::text AS ip, created_at
         FROM admin_audit ORDER BY created_at DESC, id DESC LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        admin: row.admin_login,
        action: row.action,
        targetType: row.target_type,
        targetId: row.target_id,
        details: row.details,
        ip: ip(row.ip),
        createdAt: row.created_at,
      })),
      hasMore: rows.length > limit,
    };
  }
}
