// Блокировки (таблица bans) и их проверка.
//
// Блокировка действует на аккаунт, посетителя (устройство) и/или IP (адрес или узкая подсеть).
// Проверка — на входе, на защищённых запросах, при подключении Socket.IO, при входе в комнату и перед
// игровыми событиями. Чтобы не нагружать БД во время игры, действующие блокировки держатся в памяти:
// таблица перечитывается после каждого изменения и раз в несколько минут. Истёкшие и снятые блокировки
// не действуют; если подходят несколько — показывается та, что действует дольше.
// Администратор блокировкам не подчиняется (иначе он мог бы закрыть доступ сам себе).
import { BlockList, isIP } from 'node:net';
import { AppError } from '../errors.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
export const isUuid = (value) => typeof value === 'string' && UUID.test(value);

// Самые широкие подсети, которые можно заблокировать: за одним IP часто сидит целый класс или кафе.
export const MIN_PREFIX = { 4: 24, 6: 48 };

/** «203.0.113.7» или «203.0.113.0/24» → { address, prefix, family } или null. */
export function parseIpTarget(value) {
  const [address, prefixText] = String(value ?? '').trim().split('/');
  const family = isIP(address);
  if (!family) return null;
  const full = family === 4 ? 32 : 128;
  const prefix = prefixText === undefined ? full : Number(prefixText);
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > full) return null;
  return { address: address.toLowerCase(), prefix, family, full: prefix === full };
}

function matcherFor(ipText) {
  const target = parseIpTarget(ipText);
  if (!target) return null;
  const list = new BlockList();
  const type = target.family === 4 ? 'ipv4' : 'ipv6';
  if (target.full) list.addAddress(target.address, type);
  else list.addSubnet(target.address, target.prefix, type);
  return (ip) => {
    const family = isIP(ip ?? '');
    return family !== 0 && list.check(ip, family === 4 ? 'ipv4' : 'ipv6');
  };
}

const isActive = (ban, now) => !ban.lifted_at && new Date(ban.starts_at).getTime() <= now
  && (ban.ends_at === null || new Date(ban.ends_at).getTime() > now);

/** То, что видит заблокированный: причина и срок. */
export function publicBan(ban) {
  if (!ban) return null;
  return {
    reason: ban.reason,
    since: new Date(ban.starts_at).toISOString(),
    endsAt: ban.ends_at ? new Date(ban.ends_at).toISOString() : null,
    forever: ban.ends_at === null,
  };
}

export function bannedError(ban, contact) {
  return new AppError('Вы заблокированы', { status: 403, code: 'BANNED', details: { ...publicBan(ban), contact: contact || null } });
}

export class BanService {
  #byAccount = new Map();
  #byVisitor = new Map();
  #byIp = [];
  #listeners = new Set();
  #timer = null;

  constructor(db, { reloadIntervalMs = 5 * 60_000 } = {}) {
    this.db = db;
    this.reloadIntervalMs = reloadIntervalMs;
  }

  /** Перечитать действующие и будущие блокировки. */
  async load() {
    const rows = await this.db.many(
      `SELECT id, account_id, visitor_id, ip::text AS ip, reason, starts_at, ends_at, lifted_at
         FROM bans WHERE lifted_at IS NULL AND (ends_at IS NULL OR ends_at > now())`,
    );
    const byAccount = new Map();
    const byVisitor = new Map();
    const byIp = [];
    const push = (map, key, ban) => map.set(key, [...(map.get(key) ?? []), ban]);
    for (const ban of rows) {
      if (ban.account_id) push(byAccount, ban.account_id, ban);
      if (ban.visitor_id) push(byVisitor, ban.visitor_id, ban);
      if (ban.ip) {
        const matches = matcherFor(ban.ip);
        if (matches) byIp.push({ ban, matches });
      }
    }
    this.#byAccount = byAccount;
    this.#byVisitor = byVisitor;
    this.#byIp = byIp;
    return rows.length;
  }

  start() {
    this.#timer = setInterval(() => {
      this.load().catch((error) => console.error('[bans] не удалось обновить список:', error.message));
    }, this.reloadIntervalMs);
    this.#timer.unref();
  }

  stop() {
    clearInterval(this.#timer);
  }

  /** Перечитать после изменения и сообщить подписчикам (отключить заблокированных из игр). */
  async changed() {
    await this.load();
    for (const listener of this.#listeners) {
      try {
        listener();
      } catch (error) {
        console.error('[bans] обработчик изменения:', error);
      }
    }
  }

  onChange(listener) {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /** Действующая блокировка для личности ({ account, visitorId, ip }) или null. Без запросов к БД. */
  find({ account = null, visitorId = null, ip = null } = {}) {
    if (account?.role === 'admin') return null;
    const now = Date.now();
    const candidates = [
      ...(account?.id ? this.#byAccount.get(account.id) ?? [] : []),
      ...(visitorId ? this.#byVisitor.get(visitorId) ?? [] : []),
      ...(ip ? this.#byIp.filter((entry) => entry.matches(ip)).map((entry) => entry.ban) : []),
    ].filter((ban) => isActive(ban, now));
    if (candidates.length === 0) return null;
    // Навсегда — важнее любого срока, из сроков — самый поздний.
    return candidates.reduce((best, ban) => {
      if (best.ends_at === null) return best;
      if (ban.ends_at === null) return ban;
      return new Date(ban.ends_at) > new Date(best.ends_at) ? ban : best;
    });
  }
}
