// Серверные сессии создателей игр (таблица sessions, не память процесса — переживают перезапуск).
// В cookie — случайный токен, в БД — его SHA-256. Сессия продлевается при активности
// (sessionIdleDays простоя), но живёт не дольше sessionAbsoluteDays с момента входа.
import { isToken, newToken, sha256 } from './tokens.js';

const DAY_MS = 24 * 60 * 60_000;
const RENEW_INTERVAL_MS = 5 * 60_000;

export class SessionService {
  constructor(db, { idleDays = 14, absoluteDays = 60 } = {}) {
    this.db = db;
    this.idleMs = idleDays * DAY_MS;
    this.absoluteMs = absoluteDays * DAY_MS;
  }

  get cookieMaxAgeMs() {
    return this.absoluteMs;
  }

  /** Новая сессия. runner — db или транзакция. */
  async create(accountId, { visitorId = null, ip = null, userAgent = null } = {}, runner = this.db) {
    const token = newToken();
    const row = await runner.one(
      `INSERT INTO sessions (token_hash, account_id, visitor_id, expires_at, absolute_expires_at, ip, user_agent)
       VALUES ($1, $2, $3, now() + make_interval(secs => $4), now() + make_interval(secs => $5), $6, $7)
       RETURNING id`,
      [sha256(token), accountId, visitorId, this.idleMs / 1000, this.absoluteMs / 1000, ip, userAgent?.slice(0, 400) ?? null],
    );
    return { id: row.id, token };
  }

  /** Действующая сессия по токену: { id, accountId, visitorId, account: { id, login, role } } или null. */
  async resolve(token, { ip = null, userAgent = null } = {}) {
    if (!isToken(token)) return null;
    const row = await this.db.one(
      `SELECT s.id, s.account_id, s.visitor_id, s.last_seen_at, a.login, a.role
         FROM sessions s JOIN accounts a ON a.id = s.account_id
        WHERE s.token_hash = $1 AND s.revoked_at IS NULL
          AND s.expires_at > now() AND s.absolute_expires_at > now()`,
      [sha256(token)],
    );
    if (!row) return null;
    if (Date.now() - new Date(row.last_seen_at).getTime() > RENEW_INTERVAL_MS) {
      await this.db.query(
        `UPDATE sessions SET last_seen_at = now(),
                expires_at = LEAST(now() + make_interval(secs => $2), absolute_expires_at),
                ip = COALESCE($3, ip), user_agent = COALESCE($4, user_agent)
          WHERE id = $1`,
        [row.id, this.idleMs / 1000, ip, userAgent?.slice(0, 400) ?? null],
      );
    }
    return {
      id: row.id,
      accountId: row.account_id,
      visitorId: row.visitor_id,
      account: { id: row.account_id, login: row.login, role: row.role },
    };
  }

  async revoke(sessionId, reason = 'logout') {
    await this.db.query('UPDATE sessions SET revoked_at = now(), revoke_reason = $2 WHERE id = $1 AND revoked_at IS NULL', [sessionId, reason]);
  }

  /** Отозвать все сессии аккаунта (кроме exceptId). Возвращает число отозванных. */
  async revokeAll(accountId, reason, { exceptId = null, runner = this.db } = {}) {
    const { rowCount } = await runner.query(
      `UPDATE sessions SET revoked_at = now(), revoke_reason = $2
        WHERE account_id = $1 AND revoked_at IS NULL AND ($3::uuid IS NULL OR id <> $3::uuid)`,
      [accountId, reason, exceptId],
    );
    return rowCount;
  }

  /** Удалить давно истёкшие и отозванные сессии (раз в сутки). */
  async cleanup() {
    await this.db.query(
      "DELETE FROM sessions WHERE (revoked_at IS NOT NULL AND revoked_at < now() - interval '30 days') OR absolute_expires_at < now() - interval '30 days'",
    );
  }
}
