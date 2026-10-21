// Восстановление доступа без почты и SMS.
//
// Пользователь вводит логин, код и новый пароль. Код — либо резервный (выдан при регистрации,
// 20 символов), либо одноразовый от администратора (12 символов, действует ограниченное время).
// После сброса: старый резервный код и коды администратора больше не действуют, все сессии
// аккаунта отозваны, выдаётся новый резервный код (показывается один раз).
//
// Ошибка одна и та же, есть ли такой логин или нет. Подбор ограничен лимитами (routes/auth.js)
// и числом попыток на каждый код администратора.
import { timingSafeEqual } from 'node:crypto';
import { AppError, notFound } from '../errors.js';
import { BACKUP_CODE_LENGTH, checkNewPassword, normalizeLogin } from './accounts.js';
import { newHumanCode, normalizeHumanCode, sha256 } from './tokens.js';

export const ADMIN_CODE_LENGTH = 12;
export const ADMIN_CODE_MAX_ATTEMPTS = 5;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const badRecovery = () => new AppError('Неверный логин или код восстановления', { status: 401, code: 'BAD_RECOVERY' });

const sameHash = (a, b) => Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && timingSafeEqual(a, b);

export class RecoveryService {
  constructor(db, { accounts, sessions, codeTtlMinutes = 60 }) {
    this.db = db;
    this.accounts = accounts;
    this.sessions = sessions;
    this.codeTtlMinutes = codeTtlMinutes;
  }

  /**
   * Одноразовый код от администратора для аккаунта accountId. Прежние неиспользованные коды отзываются.
   * Возвращает { code, expiresAt, login, revoked } — код показывается администратору один раз.
   */
  async issueAdminCode(accountId, adminId, runner) {
    if (!UUID.test(String(accountId))) throw notFound('Аккаунт не найден');
    const account = await runner.one('SELECT id, login, role FROM accounts WHERE id = $1 FOR UPDATE', [accountId]);
    if (!account) throw notFound('Аккаунт не найден');
    if (account.role === 'admin') throw new AppError('Доступ администратора восстанавливается через настройки сервера.', { status: 409, code: 'ADMIN_MANAGED' });
    const { rowCount: revoked } = await runner.query(
      "UPDATE recovery_codes SET revoked_at = now(), revoke_reason = 'replaced' WHERE account_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
      [accountId],
    );
    const code = newHumanCode(ADMIN_CODE_LENGTH);
    const row = await runner.one(
      `INSERT INTO recovery_codes (account_id, code_hash, created_by, expires_at)
       VALUES ($1, $2, $3, now() + make_interval(mins => $4)) RETURNING expires_at`,
      [accountId, sha256(normalizeHumanCode(code)), adminId, this.codeTtlMinutes],
    );
    return { code, expiresAt: new Date(row.expires_at).toISOString(), login: account.login, revoked };
  }

  /**
   * Сброс пароля по коду. Возвращает { account, backupCode, method } или бросает BAD_RECOVERY.
   * Неудачная попытка тоже сохраняется (счётчик попыток кода), поэтому результат транзакции
   * сначала фиксируется, а ошибка бросается уже после.
   */
  async recover({ login: rawLogin, code: rawCode, newPassword }) {
    const login = normalizeLogin(rawLogin).slice(0, 64);
    const code = normalizeHumanCode(rawCode).slice(0, 64);
    // Новый пароль проверяем до поиска аккаунта: ответ не зависит от того, существует ли логин.
    const password = checkNewPassword(newPassword, String(rawLogin ?? '').trim());
    if (!login || (code.length !== BACKUP_CODE_LENGTH && code.length !== ADMIN_CODE_LENGTH)) throw badRecovery();
    const hash = sha256(code);
    const passwordHash = await this.accounts.hashPassword(password);

    const result = await this.db.tx(async (tx) => {
      const account = await tx.one('SELECT id, login, role, backup_code_hash FROM accounts WHERE login_normalized = $1 FOR UPDATE', [login]);
      if (!account || account.role === 'admin') return { ok: false };

      let method = null;
      if (code.length === BACKUP_CODE_LENGTH && sameHash(hash, account.backup_code_hash)) {
        method = 'backup';
      } else if (code.length === ADMIN_CODE_LENGTH) {
        const used = await tx.one(
          `UPDATE recovery_codes SET used_at = now()
            WHERE account_id = $1 AND code_hash = $2 AND used_at IS NULL AND revoked_at IS NULL
              AND expires_at > now() AND attempts < $3
          RETURNING id`,
          [account.id, hash, ADMIN_CODE_MAX_ATTEMPTS],
        );
        if (used) method = 'admin';
      }

      if (!method) {
        // Неверный код расходует попытку у действующего кода администратора; после последней код отзывается.
        await tx.query(
          `UPDATE recovery_codes SET attempts = attempts + 1,
                  revoked_at = CASE WHEN attempts + 1 >= $2 THEN now() ELSE revoked_at END,
                  revoke_reason = CASE WHEN attempts + 1 >= $2 THEN 'too-many-attempts' ELSE revoke_reason END
            WHERE account_id = $1 AND used_at IS NULL AND revoked_at IS NULL`,
          [account.id, ADMIN_CODE_MAX_ATTEMPTS],
        );
        return { ok: false };
      }

      const backupCode = newHumanCode(BACKUP_CODE_LENGTH);
      await tx.query(
        `UPDATE accounts SET password_hash = $2, password_changed_at = now(),
                backup_code_hash = $3, backup_code_created_at = now()
          WHERE id = $1`,
        [account.id, passwordHash, sha256(normalizeHumanCode(backupCode))],
      );
      await tx.query(
        "UPDATE recovery_codes SET revoked_at = now(), revoke_reason = 'password-reset' WHERE account_id = $1 AND used_at IS NULL AND revoked_at IS NULL",
        [account.id],
      );
      await this.sessions.revokeAll(account.id, 'password-reset', { runner: tx });
      return { ok: true, method, backupCode, account: { id: account.id, login: account.login, role: account.role } };
    });

    if (!result.ok) throw badRecovery();
    return result;
  }
}
