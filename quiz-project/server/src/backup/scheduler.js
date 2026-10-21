// Ежедневный бэкап внутри процесса: дамп → шифрование → загрузка во внешнее хранилище → проверка
// загруженного файла (скачать, расшифровать, сверить со сводкой) → удаление старых копий.
// Состояние (когда и чем закончился последний бэкап) — в settings, его видно в админ-консоли.
// Advisory-блокировка не даёт двум процессам (старому и новому при деплое) делать бэкап одновременно.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createBackup, readBackup } from './dump.js';
import { parseKey } from './crypto.js';

const STATE_KEY = 'backup_last';
const LOCK_KEY = 482_731_906;
const CHECK_INTERVAL_MS = 60 * 60_000;
const RETRY_AFTER_MS = 60 * 60_000;

const stamp = (date) => date.toISOString().replace(/[-:]/g, '').replace(/\.\d+Z$/, 'Z').replace('T', '-');

export class BackupScheduler {
  #timer = null;
  #first = null;
  #running = null;

  constructor({ db, storage, encryptionKey, intervalHours = 24, keep = 14, log = console.log }) {
    this.db = db;
    this.storage = storage;
    this.key = parseKey(encryptionKey);
    this.intervalMs = intervalHours * 60 * 60_000;
    this.keep = keep;
    this.log = log;
  }

  async status() {
    const row = await this.db.one('SELECT value FROM settings WHERE key = $1', [STATE_KEY]);
    return row?.value ?? null;
  }

  async #save(state) {
    await this.db.query(
      `INSERT INTO settings (key, value) VALUES ($1, $2)
       ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value, updated_at = now()`,
      [STATE_KEY, state],
    );
  }

  start({ firstDelayMs = 2 * 60_000 } = {}) {
    this.#first = setTimeout(() => this.runIfDue(), firstDelayMs);
    this.#first.unref();
    this.#timer = setInterval(() => this.runIfDue(), CHECK_INTERVAL_MS);
    this.#timer.unref();
  }

  stop() {
    clearTimeout(this.#first);
    clearInterval(this.#timer);
  }

  async runIfDue() {
    try {
      const state = await this.status();
      const lastSuccess = state?.successAt ? Date.parse(state.successAt) : 0;
      const lastAttempt = state?.attemptAt ? Date.parse(state.attemptAt) : 0;
      if (Date.now() - lastSuccess < this.intervalMs || Date.now() - lastAttempt < RETRY_AFTER_MS) return null;
      return await this.run();
    } catch (error) {
      this.log?.(`[backup] проверка расписания не удалась: ${error.message}`);
      return null;
    }
  }

  /** Сделать бэкап сейчас. Возвращает состояние (как в settings). */
  run() {
    this.#running ??= this.#run().finally(() => {
      this.#running = null;
    });
    return this.#running;
  }

  async #run() {
    const client = await this.db.pool.connect();
    let locked = false;
    const attemptAt = new Date();
    const previous = await this.status().catch(() => null);
    const tmp = path.join(os.tmpdir(), `alstudio-backup-${randomBytes(4).toString('hex')}`);
    const name = `alstudio-${stamp(attemptAt)}.alsb`;
    const local = `${tmp}.alsb`;
    const check = `${tmp}-check.alsb`;
    try {
      locked = (await client.query('SELECT pg_try_advisory_lock($1) AS ok', [LOCK_KEY])).rows[0].ok;
      if (!locked) return previous;
      const started = Date.now();
      const { manifest, schemaVersion } = await createBackup(this.db, local, this.key);
      const uploaded = await this.storage.upload(name, local);
      // Проверяем не локальный файл, а то, что реально лежит в хранилище.
      await this.storage.download(uploaded.id, check);
      await readBackup(check, this.key);
      const removed = await this.#prune();
      const rows = Object.values(manifest).reduce((sum, item) => sum + item.count, 0);
      const state = {
        ok: true,
        attemptAt: attemptAt.toISOString(),
        successAt: new Date().toISOString(),
        name,
        size: uploaded.size,
        rows,
        schemaVersion,
        verified: true,
        removedOld: removed,
        durationMs: Date.now() - started,
      };
      await this.#save(state);
      this.log?.(`[backup] готово: ${name}, ${rows} строк, ${Math.round(uploaded.size / 1024)} КБ, проверен после загрузки`);
      return state;
    } catch (error) {
      const state = { ...(previous ?? {}), ok: false, attemptAt: attemptAt.toISOString(), error: error.message.slice(0, 300) };
      await this.#save(state).catch(() => {});
      this.log?.(`[backup] НЕ УДАЛСЯ: ${error.message}`);
      return state;
    } finally {
      if (locked) await client.query('SELECT pg_advisory_unlock($1)', [LOCK_KEY]).catch(() => {});
      client.release();
      await fs.rm(local, { force: true }).catch(() => {});
      await fs.rm(check, { force: true }).catch(() => {});
    }
  }

  async #prune() {
    const items = await this.storage.list();
    const stale = items.sort((a, b) => b.name.localeCompare(a.name)).slice(this.keep);
    for (const item of stale) await this.storage.remove(item.id);
    return stale.length;
  }
}
