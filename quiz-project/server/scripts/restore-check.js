// Проверка восстановления: npm run restore-check [-- --file путь.alsb]
// Без --file берётся самая свежая копия из хранилища (Google Drive или BACKUP_DIR).
// Копия разворачивается во временную схему той же базы (или RESTORE_DATABASE_URL), суммы всех таблиц
// сверяются со сводкой бэкапа, схема удаляется. Рабочие данные не затрагиваются.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { parseKey } from '../src/backup/crypto.js';
import { restoreCheck } from '../src/backup/restore.js';
import { storageFromConfig } from '../src/backup/storage.js';

const config = loadConfig();
const args = process.argv.slice(2);
const fileArg = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
const key = parseKey(config.backup.encryptionKey);
let file = fileArg;
let temp = null;
try {
  if (!file) {
    const storage = storageFromConfig(config);
    if (!storage) throw new Error('Не задано хранилище бэкапов (GOOGLE_DRIVE_* или BACKUP_DIR), а --file не указан.');
    const [latest] = await storage.list();
    if (!latest) throw new Error('В хранилище нет ни одной копии.');
    temp = path.join(os.tmpdir(), `alstudio-restore-check-${process.pid}.alsb`);
    await storage.download(latest.id, temp);
    file = temp;
    console.log(`Проверяю копию ${latest.name}`);
  }
  const url = process.env.RESTORE_DATABASE_URL || config.databaseUrl;
  const result = await restoreCheck({ url, ssl: config.databaseSsl, file, key });
  if (!result.ok) process.exitCode = 1;
} catch (error) {
  console.error(`Проверка не удалась: ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temp) await fs.rm(temp, { force: true });
}
