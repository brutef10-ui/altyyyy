// Применить миграции БД без запуска сервера: npm run migrate
// (сервер и сам применяет их при старте под блокировкой, так что это необязательный шаг).
import { loadConfig } from '../src/config.js';
import { createDb } from '../src/db/index.js';
import { migrate } from '../src/db/migrate.js';

const config = loadConfig();
const db = createDb({ url: config.databaseUrl, ssl: config.databaseSsl, schema: config.databaseSchema || undefined });
try {
  const applied = await migrate(db);
  console.log(applied.length ? `Применено миграций: ${applied.length}` : 'Схема БД актуальна.');
} catch (error) {
  console.error(`Миграции не применены: ${error.message}`);
  process.exitCode = 1;
} finally {
  await db.close();
}
