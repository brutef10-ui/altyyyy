// Доверенные устройства администратора (таблица admin_devices).
//
// В админ-консоль можно войти только с доверенного устройства — браузера с cookie посетителя (vid).
// Свободное место (их не больше max) занимает первое устройство, с которого администратор вошёл
// с верным паролем; когда места заняты, вход с других устройств отклоняется, даже с верным паролем.
// Убрать устройство можно в консоли; потерянные устройства сбрасываются переменной ADMIN_DEVICE_RESET.
//
// Список держим в памяти (проверка на каждом запросе к консоли — без запроса к БД).
import { createHash } from 'node:crypto';

const SETTING = 'admin_devices';

export class AdminDeviceService {
  #trusted = new Map(); // accountId → Set(visitorId)

  constructor(db, { max = 2 } = {}) {
    this.db = db;
    this.max = max;
  }

  /** Есть ли устройство в списке доверенных у этого администратора. Только память. */
  isTrusted(accountId, visitorId) {
    return Boolean(accountId && visitorId && this.#trusted.get(accountId)?.has(visitorId));
  }

  async load() {
    const rows = await this.db.many('SELECT account_id, visitor_id FROM admin_devices');
    const trusted = new Map();
    for (const row of rows) {
      if (!trusted.has(row.account_id)) trusted.set(row.account_id, new Set());
      trusted.get(row.account_id).add(row.visitor_id);
    }
    this.#trusted = trusted;
  }

  /**
   * При старте сервера. Первый запуск с этой функцией: доверенными становятся устройства, на которых
   * администратор уже вошёл (до max самых недавних). resetToken (ADMIN_DEVICE_RESET) — новое значение
   * один раз очищает список и завершает сессии администратора. Возвращает, что произошло.
   */
  async init({ resetToken = '', sessions = null } = {}) {
    const result = await this.db.tx(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock(hashtext('admin_devices'))");
      const state = (await tx.one('SELECT value FROM settings WHERE key = $1', [SETTING]))?.value ?? {};
      const admins = (await tx.many("SELECT id FROM accounts WHERE role = 'admin'")).map((row) => row.id);
      const out = { bootstrapped: 0, reset: false, admins };
      const tokenHash = resetToken ? createHash('sha256').update(resetToken).digest('hex') : null;

      if (tokenHash && tokenHash !== state.resetHash) {
        await tx.query('DELETE FROM admin_devices');
        for (const id of admins) await sessions?.revokeAll(id, 'admin-devices-reset', { runner: tx });
        state.resetHash = tokenHash;
        state.initialized = true;
        out.reset = true;
      }

      if (!state.initialized) {
        for (const accountId of admins) {
          const active = await tx.many(
            `SELECT DISTINCT ON (s.visitor_id) s.visitor_id, s.ip, s.user_agent, s.last_seen_at
               FROM sessions s JOIN visitors v ON v.id = s.visitor_id
              WHERE s.account_id = $1 AND s.revoked_at IS NULL
                AND s.expires_at > now() AND s.absolute_expires_at > now()
              ORDER BY s.visitor_id, s.last_seen_at DESC`,
            [accountId],
          );
          active.sort((a, b) => new Date(b.last_seen_at) - new Date(a.last_seen_at));
          for (const row of active.slice(0, this.max)) {
            await tx.query(
              `INSERT INTO admin_devices (visitor_id, account_id, user_agent, last_seen_at, last_ip)
               VALUES ($1, $2, $3, $4, $5) ON CONFLICT (visitor_id) DO NOTHING`,
              [row.visitor_id, accountId, row.user_agent, row.last_seen_at, row.ip],
            );
            out.bootstrapped += 1;
          }
        }
        state.initialized = true;
      }

      await tx.query(
        `INSERT INTO settings (key, value) VALUES ($1, $2)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
        [SETTING, state],
      );
      return out;
    });
    await this.load();
    return result;
  }

  /**
   * Вход администратора с верным паролем: пускать ли с этого устройства.
   * { ok: true, added } — устройство уже доверенное или заняло свободное место; { ok: false } — места заняты.
   */
  async admit(account, { visitorId, ip = null, userAgent = null }) {
    if (!visitorId) return { ok: false };
    const result = await this.db.tx(async (tx) => {
      // Два входа одновременно не должны занять больше мест, чем есть.
      await tx.query('SELECT pg_advisory_xact_lock(hashtext($1))', [`admin_devices:${account.id}`]);
      const known = await tx.one('SELECT account_id FROM admin_devices WHERE visitor_id = $1', [visitorId]);
      if (known?.account_id === account.id) {
        await tx.query('UPDATE admin_devices SET last_seen_at = now(), last_ip = $2, user_agent = COALESCE($3, user_agent) WHERE visitor_id = $1', [visitorId, ip, userAgent?.slice(0, 400) ?? null]);
        return { ok: true, added: false };
      }
      if (known) return { ok: false };
      const { count } = await tx.one('SELECT count(*)::int AS count FROM admin_devices WHERE account_id = $1', [account.id]);
      if (count >= this.max) return { ok: false };
      await tx.query(
        'INSERT INTO admin_devices (visitor_id, account_id, user_agent, last_ip) VALUES ($1, $2, $3, $4)',
        [visitorId, account.id, userAgent?.slice(0, 400) ?? null, ip],
      );
      return { ok: true, added: true };
    });
    if (result.added) await this.load();
    return result;
  }

  async list(accountId) {
    return this.db.many(
      `SELECT visitor_id, user_agent, added_at, last_seen_at, host(last_ip) AS last_ip
         FROM admin_devices WHERE account_id = $1 ORDER BY added_at`,
      [accountId],
    );
  }

  /** Убрать устройство и завершить на нём сессии администратора. runner — транзакция вызывающего. */
  async remove(accountId, visitorId, runner) {
    const { rowCount } = await runner.query('DELETE FROM admin_devices WHERE account_id = $1 AND visitor_id = $2', [accountId, visitorId]);
    if (rowCount) {
      await runner.query(
        "UPDATE sessions SET revoked_at = now(), revoke_reason = 'admin-device-removed' WHERE account_id = $1 AND visitor_id = $2 AND revoked_at IS NULL",
        [accountId, visitorId],
      );
    }
    return rowCount > 0;
  }
}
