// Лимиты попыток входа, регистрации и восстановления. Хранятся в БД (таблица auth_throttle),
// поэтому перезапуск сервера или деплой не обнуляет счётчики подбора пароля.
//
// Правило: { max, windowSec, blockSec } — после max событий за windowSec ключ блокируется на blockSec.
import { AppError } from '../errors.js';

export const RULES = Object.freeze({
  loginIp: { max: 30, windowSec: 15 * 60, blockSec: 15 * 60 },
  loginAccountIp: { max: 5, windowSec: 15 * 60, blockSec: 15 * 60 },
  // Распределённый подбор одного логина с разных IP.
  loginAccount: { max: 50, windowSec: 60 * 60, blockSec: 60 * 60 },
  registerVisitor: { max: 3, windowSec: 60 * 60, blockSec: 60 * 60 },
  passwordChange: { max: 10, windowSec: 15 * 60, blockSec: 15 * 60 },
});

export function throttled(seconds) {
  const minutes = Math.max(1, Math.ceil(seconds / 60));
  return new AppError(`Слишком много попыток. Попробуйте через ${minutes} мин.`, { status: 429, code: 'RATE_LIMIT', details: { retryAfter: seconds } });
}

export class Throttle {
  constructor(db) {
    this.db = db;
  }

  /** Сколько секунд ещё действует блокировка (0 — можно). */
  async blockedFor(key) {
    const row = await this.db.one(
      'SELECT CEIL(EXTRACT(EPOCH FROM (blocked_until - now())))::int AS seconds FROM auth_throttle WHERE key = $1 AND blocked_until > now()',
      [key],
    );
    return row?.seconds ?? 0;
  }

  /** Бросает 429, если хоть один ключ заблокирован. */
  async check(...keys) {
    for (const key of keys) {
      const seconds = await this.blockedFor(key);
      if (seconds > 0) throw throttled(seconds);
    }
  }

  /** Засчитать событие. Возвращает true, если ключ теперь заблокирован. */
  async hit(key, { max, windowSec, blockSec }) {
    const row = await this.db.one(
      `INSERT INTO auth_throttle (key, failures, window_started_at) VALUES ($1, 1, now())
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN auth_throttle.window_started_at < now() - make_interval(secs => $2) THEN 1 ELSE auth_throttle.failures + 1 END,
         window_started_at = CASE WHEN auth_throttle.window_started_at < now() - make_interval(secs => $2) THEN now() ELSE auth_throttle.window_started_at END
       RETURNING failures`,
      [key, windowSec],
    );
    if (row.failures < max) return false;
    await this.db.query('UPDATE auth_throttle SET blocked_until = now() + make_interval(secs => $2) WHERE key = $1', [key, blockSec]);
    return true;
  }

  async reset(key) {
    await this.db.query('DELETE FROM auth_throttle WHERE key = $1', [key]);
  }

  /** Убрать старые счётчики (раз в час). */
  async cleanup() {
    await this.db.query(
      "DELETE FROM auth_throttle WHERE window_started_at < now() - interval '1 day' AND (blocked_until IS NULL OR blocked_until < now())",
    );
  }
}
