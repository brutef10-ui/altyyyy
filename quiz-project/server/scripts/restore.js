// Восстановление из резервной копии в НОВУЮ ПУСТУЮ базу:
//   DATABASE_URL=<адрес новой базы> npm run restore -- --file путь.alsb --yes
//   DATABASE_URL=<адрес новой базы> npm run restore -- --latest --yes      (самая свежая из хранилища)
// В непустую базу не восстанавливает (защита от случайной перезаписи). Пользователи после восстановления
// входят заново: сессии в копию не входят.
import os from 'node:os';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { parseKey } from '../src/backup/crypto.js';
import { restoreBackup } from '../src/backup/restore.js';
import { storageFromConfig } from '../src/backup/storage.js';

const config = loadConfig();
const args = process.argv.slice(2);
if (!args.includes('--yes')) {
  console.error('Добавьте --yes, чтобы подтвердить восстановление в базу из DATABASE_URL.');
  process.exit(1);
}
const key = parseKey(config.backup.encryptionKey);
let file = args.includes('--file') ? args[args.indexOf('--file') + 1] : null;
let temp = null;
const db = createDb({ url: config.databaseUrl, ssl: config.databaseSsl, schema: config.databaseSchema || undefined, statementTimeoutMs: 300_000 });
try {
  if (!file && args.includes('--latest')) {
    const storage = storageFromConfig(config);
    const [latest] = storage ? await storage.list() : [];
    if (!latest) throw new Error('В хранилище нет копий.');
    temp = path.join(os.tmpdir(), `luminous-restore-${process.pid}.alsb`);
    await storage.download(latest.id, temp);
    file = temp;
    console.log(`Восстанавливаю ${latest.name}`);
  }
  if (!file) throw new Error('Укажите --file путь.alsb или --latest.');
  const result = await restoreBackup(db, file, key);
  const total = Object.values(result.counts).reduce((sum, count) => sum + count, 0);
  console.log(`Готово: восстановлено строк ${total}.`, result.counts);
} catch (error) {
  console.error(`Восстановление не удалось (база не изменена): ${error.message}`);
  process.exitCode = 1;
} finally {
  if (temp) await fs.rm(temp, { force: true });
  await db.close();
}
