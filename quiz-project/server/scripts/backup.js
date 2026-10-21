// Сделать резервную копию сейчас: npm run backup
// Нужны DATABASE_URL, BACKUP_ENCRYPTION_KEY и хранилище (GOOGLE_DRIVE_* или BACKUP_DIR).
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { BackupScheduler } from '../src/backup/scheduler.js';
import { storageFromConfig } from '../src/backup/storage.js';

const config = loadConfig();
const storage = storageFromConfig(config);
if (!storage || !config.backup.encryptionKey) {
  console.error('Не настроено: нужны BACKUP_ENCRYPTION_KEY и GOOGLE_DRIVE_* (или BACKUP_DIR).');
  process.exit(1);
}
const db = createDb({ url: config.databaseUrl, ssl: config.databaseSsl, schema: config.databaseSchema || undefined });
try {
  const scheduler = new BackupScheduler({ db, storage, encryptionKey: config.backup.encryptionKey, keep: config.backup.keep });
  const state = await scheduler.run();
  if (!state?.ok) process.exitCode = 1;
} finally {
  await db.close();
}
