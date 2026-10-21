// Аккаунты создателей игр: регистрация, вход, пароли, резервный код.
//
// * Пароли — argon2id (параметры OWASP: 19 МиБ, 2 прохода, 1 поток). В открытом виде нигде не хранятся.
// * Неизвестный логин и неверный пароль дают одну и ту же ошибку и тратят одинаковое время
//   (пароль проверяется против фиктивного хэша), чтобы по ответу нельзя было узнать, есть ли логин.
// * Резервный код показывается один раз при регистрации (и при перевыпуске); в БД — только SHA-256.
// * Роль admin выдаёт только ensureAdmin() из переменных окружения. Данные клиента роль не меняют.
import argon2 from 'argon2';
import { AppError, conflict } from '../errors.js';
import { isUniqueViolation } from '../db/index.js';
import { newHumanCode, normalizeHumanCode, sha256 } from './tokens.js';

export const LOGIN_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{2,31}$/;
export const PASSWORD_MIN = 8;
export const PASSWORD_MAX = 128;
export const BACKUP_CODE_LENGTH = 20;
const PRINTABLE_ASCII = /^[\x20-\x7E]+$/;
const RESERVED = new Set(['admin', 'administrator', 'root', 'support', 'system', 'moderator', 'alstudio', 'al-studio', 'host', 'player']);

const HASH_OPTIONS = { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 };

export const normalizeLogin = (value) => String(value ?? '').trim().normalize('NFC').toLowerCase();

const invalid = (message, code = 'INVALID') => new AppError(message, { status: 422, code });

export function checkNewLogin(value) {
  const login = String(value ?? '').trim();
  if (!LOGIN_PATTERN.test(login)) {
    throw invalid('Логин: 3–32 символа, латинские буквы, цифры, «_», «.» или «-», начинается с буквы.', 'BAD_LOGIN');
  }
  return login;
}

export function checkNewPassword(value, login = '') {
  const password = typeof value === 'string' ? value : '';
  if (password.length < PASSWORD_MIN || password.length > PASSWORD_MAX) {
    throw invalid(`Пароль: от ${PASSWORD_MIN} до ${PASSWORD_MAX} символов.`, 'BAD_PASSWORD');
  }
  if (!PRINTABLE_ASCII.test(password)) {
    throw invalid('Пароль: только латинские буквы, цифры и знаки (без кириллицы).', 'BAD_PASSWORD');
  }
  if (login && password.toLowerCase().includes(normalizeLogin(login))) {
    throw invalid('Пароль не должен содержать логин.', 'BAD_PASSWORD');
  }
  return password;
}

const badCredentials = () => new AppError('Неверный логин или пароль', { status: 401, code: 'BAD_CREDENTIALS' });

const publicAccount = (row) => ({ id: row.id, login: row.login, role: row.role });

export class AccountService {
  #dummyHash = null;

  constructor(db, { adminLogin = '' } = {}) {
    this.db = db;
    this.adminLoginNormalized = adminLogin ? normalizeLogin(adminLogin) : '';
  }

  hashPassword(password) {
    return argon2.hash(password, HASH_OPTIONS);
  }

  async #verify(hash, password) {
    try {
      return await argon2.verify(hash, password);
    } catch {
      return false;
    }
  }

  async #dummyVerify(password) {
    this.#dummyHash ??= await this.hashPassword('dummy-password-to-equalize-timing');
    await this.#verify(this.#dummyHash, password);
  }

  isReservedLogin(login) {
    const normalized = normalizeLogin(login);
    return RESERVED.has(normalized) || (this.adminLoginNormalized && normalized === this.adminLoginNormalized);
  }

  #newBackupCode() {
    const code = newHumanCode(BACKUP_CODE_LENGTH);
    return { code, hash: sha256(normalizeHumanCode(code)) };
  }

  /** Регистрация. Возвращает { account, backupCode } — код показывается пользователю один раз. */
  async register({ login: rawLogin, password: rawPassword }, runner = this.db) {
    const login = checkNewLogin(rawLogin);
    const password = checkNewPassword(rawPassword, login);
    if (this.isReservedLogin(login)) throw conflict('Этот логин занят. Выберите другой.', 'LOGIN_TAKEN');
    const passwordHash = await this.hashPassword(password);
    const backup = this.#newBackupCode();
    try {
      const row = await runner.one(
        `INSERT INTO accounts (login, login_normalized, password_hash, backup_code_hash, backup_code_created_at)
         VALUES ($1, $2, $3, $4, now()) RETURNING id, login, role`,
        [login, normalizeLogin(login), passwordHash, backup.hash],
      );
      return { account: publicAccount(row), backupCode: backup.code };
    } catch (error) {
      if (isUniqueViolation(error)) throw conflict('Этот логин занят. Выберите другой.', 'LOGIN_TAKEN');
      throw error;
    }
  }

  /** Проверка логина и пароля. Бросает BAD_CREDENTIALS в любом неуспешном случае. */
  async authenticate(rawLogin, rawPassword) {
    const login = normalizeLogin(rawLogin);
    const password = typeof rawPassword === 'string' ? rawPassword : '';
    const row = login.length > 0 && login.length <= 64 && password.length <= PASSWORD_MAX * 4
      ? await this.db.one('SELECT id, login, role, password_hash FROM accounts WHERE login_normalized = $1', [login])
      : null;
    if (!row) {
      await this.#dummyVerify(password);
      throw badCredentials();
    }
    if (!password || !(await this.#verify(row.password_hash, password))) throw badCredentials();
    return publicAccount(row);
  }

  async markLogin(accountId, runner = this.db) {
    await runner.query('UPDATE accounts SET last_login_at = now() WHERE id = $1', [accountId]);
  }

  async findById(accountId) {
    const row = await this.db.one('SELECT id, login, role FROM accounts WHERE id = $1', [accountId]);
    return row ? publicAccount(row) : null;
  }

  async #requirePassword(accountId, password) {
    const row = await this.db.one('SELECT id, login, role, password_hash FROM accounts WHERE id = $1', [accountId]);
    if (!row || typeof password !== 'string' || !(await this.#verify(row.password_hash, password))) {
      throw new AppError('Неверный текущий пароль', { status: 403, code: 'BAD_PASSWORD' });
    }
    return row;
  }

  /** Смена пароля по текущему паролю. Админу пароль меняют только в настройках сервера. */
  async changePassword(accountId, currentPassword, newPassword) {
    const row = await this.#requirePassword(accountId, currentPassword);
    if (row.role === 'admin') throw new AppError('Пароль администратора задаётся в настройках сервера.', { status: 403, code: 'ADMIN_MANAGED' });
    const password = checkNewPassword(newPassword, row.login);
    if (password === currentPassword) throw invalid('Новый пароль совпадает с текущим.', 'BAD_PASSWORD');
    await this.db.query('UPDATE accounts SET password_hash = $2, password_changed_at = now() WHERE id = $1', [accountId, await this.hashPassword(password)]);
  }

  /** Новый резервный код (старый перестаёт действовать). Требует текущий пароль. */
  async regenerateBackupCode(accountId, currentPassword) {
    const row = await this.#requirePassword(accountId, currentPassword);
    if (row.role === 'admin') throw new AppError('Доступ администратора восстанавливается через настройки сервера.', { status: 403, code: 'ADMIN_MANAGED' });
    const backup = this.#newBackupCode();
    await this.db.query('UPDATE accounts SET backup_code_hash = $2, backup_code_created_at = now() WHERE id = $1', [accountId, backup.hash]);
    return backup.code;
  }

  /**
   * Аккаунт администратора из окружения: ADMIN_LOGIN + ADMIN_PASSWORD_HASH (argon2id).
   * Других администраторов нет: аккаунты с ролью admin и другим логином понижаются до user.
   * Если логин уже занят обычным аккаунтом — роль не выдаётся (иначе его владелец стал бы админом).
   * Возвращает { status, revokedSessions }.
   */
  async ensureAdmin({ login, passwordHash }, sessions) {
    const normalized = login ? normalizeLogin(login) : '';
    const demoted = await this.db.many(
      "UPDATE accounts SET role = 'user' WHERE role = 'admin' AND login_normalized <> $1 RETURNING id",
      [normalized],
    );
    for (const { id } of demoted) await sessions?.revokeAll(id, 'admin-demoted');
    if (!normalized || !passwordHash) return { status: 'disabled', demoted: demoted.length };
    if (!passwordHash.startsWith('$argon2')) {
      console.error('[admin] ADMIN_PASSWORD_HASH должен быть хэшем argon2 (npm run hash-password). Вход администратора отключён.');
      return { status: 'bad-hash', demoted: demoted.length };
    }
    if (login.length > 64) {
      console.error('[admin] ADMIN_LOGIN длиннее 64 символов. Вход администратора отключён.');
      return { status: 'bad-login', demoted: demoted.length };
    }

    const existing = await this.db.one('SELECT id, role, password_hash FROM accounts WHERE login_normalized = $1', [normalized]);
    if (!existing) {
      await this.db.query(
        "INSERT INTO accounts (login, login_normalized, password_hash, role) VALUES ($1, $2, $3, 'admin')",
        [login, normalized, passwordHash],
      );
      return { status: 'created', demoted: demoted.length };
    }
    if (existing.role !== 'admin') {
      console.error('[admin] Логин ADMIN_LOGIN уже занят обычным аккаунтом — роль администратора НЕ выдана. Выберите другой ADMIN_LOGIN.');
      return { status: 'conflict', demoted: demoted.length };
    }
    if (existing.password_hash !== passwordHash) {
      // Пароль администратора сменили в окружении — старые сессии больше не действуют.
      await this.db.query('UPDATE accounts SET password_hash = $2, password_changed_at = now(), login = $3 WHERE id = $1', [existing.id, passwordHash, login]);
      await sessions?.revokeAll(existing.id, 'password-changed');
      return { status: 'updated', demoted: demoted.length };
    }
    return { status: 'ok', demoted: demoted.length };
  }
}
