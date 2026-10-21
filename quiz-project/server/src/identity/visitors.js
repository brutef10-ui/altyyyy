// Посетитель — браузер/устройство. Случайный токен лежит в HttpOnly-cookie на год, в БД — его SHA-256.
// visitor_id — не доказательство личности (cookie можно стереть или скопировать), а метка для журналов,
// блокировок и связи гостевой истории с аккаунтом.
import { isToken, newToken, sha256 } from './tokens.js';
import { RateLimiter } from '../rateLimit.js';

export const VISITOR_COOKIE_MAX_AGE_MS = 365 * 24 * 60 * 60_000;
// Не чаще раза в 5 минут обновляем «последний визит» — чтобы не писать в БД на каждый запрос.
const TOUCH_INTERVAL_MS = 5 * 60_000;
const USER_AGENT_MAX = 400;

const trimAgent = (value) => (typeof value === 'string' ? value.slice(0, USER_AGENT_MAX) : null);

export class VisitorService {
  constructor(db) {
    this.db = db;
    // Новые посетители с одного IP: защита таблицы от ботов, которые не хранят cookie.
    this.createLimiter = new RateLimiter({ windowMs: 10 * 60_000, max: 60 });
  }

  /** Посетитель по токену из cookie (или null). Заодно отмечает визит. */
  async find(token, { ip = null, userAgent = null } = {}) {
    if (!isToken(token)) return null;
    const row = await this.db.one('SELECT id, last_seen_at, host(last_ip) AS last_ip FROM visitors WHERE token_hash = $1', [sha256(token)]);
    if (!row) return null;
    const stale = Date.now() - new Date(row.last_seen_at).getTime() > TOUCH_INTERVAL_MS;
    if (stale || (ip && row.last_ip !== ip)) {
      await this.db.query('UPDATE visitors SET last_seen_at = now(), last_ip = $2, last_user_agent = $3 WHERE id = $1', [row.id, ip, trimAgent(userAgent)]);
    }
    return { id: row.id, touched: stale };
  }

  /** Новый посетитель. null — если с этого IP создано слишком много посетителей подряд. */
  async create({ ip = null, userAgent = null } = {}) {
    if (ip && !this.createLimiter.take(ip)) return null;
    const token = newToken();
    const row = await this.db.one(
      'INSERT INTO visitors (token_hash, last_ip, last_user_agent) VALUES ($1, $2, $3) RETURNING id',
      [sha256(token), ip, trimAgent(userAgent)],
    );
    return { id: row.id, token, isNew: true };
  }

  /** Связать устройство с аккаунтом (многие ко многим; гостевая история посетителя сохраняется). */
  async linkAccount(visitorId, accountId) {
    await this.db.query(
      `INSERT INTO visitor_accounts (visitor_id, account_id) VALUES ($1, $2)
       ON CONFLICT (visitor_id, account_id) DO UPDATE SET last_used_at = now()`,
      [visitorId, accountId],
    );
  }

  stop() {
    this.createLimiter.stop();
  }
}
