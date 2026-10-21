// Миграции схемы БД: файлы server/migrations/NNN_название.sql применяются по порядку номеров.
//
// * Все миграции одного запуска выполняются в одной транзакции под pg_advisory_xact_lock:
//   два процесса (например, старый и новый при деплое) не применят их одновременно,
//   а при ошибке не останется половины изменений.
// * Применённая миграция больше не меняется — изменения схемы только новыми файлами.
// * Миграции только добавляют (таблицы, столбцы, индексы) и не удаляют данные.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const MIGRATIONS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations');
const FILE_PATTERN = /^(\d{3})_[a-z0-9_-]+\.sql$/;
// Произвольное постоянное число — «имя» блокировки миграций.
const LOCK_KEY = 482_731_905;

export async function listMigrations(dir = MIGRATIONS_DIR) {
  const files = (await fs.readdir(dir)).filter((name) => FILE_PATTERN.test(name)).sort();
  const seen = new Set();
  return Promise.all(files.map(async (name) => {
    const version = Number(FILE_PATTERN.exec(name)[1]);
    if (seen.has(version)) throw new Error(`Две миграции с номером ${version}`);
    seen.add(version);
    return { version, name, sql: await fs.readFile(path.join(dir, name), 'utf8') };
  }));
}

/** Применить недостающие миграции. Возвращает список применённых сейчас. */
export async function migrate(db, { dir = MIGRATIONS_DIR, log = console.log } = {}) {
  const migrations = await listMigrations(dir);
  return db.tx(async (tx) => {
    await tx.query('SELECT pg_advisory_xact_lock($1)', [LOCK_KEY]);
    await tx.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      version integer PRIMARY KEY,
      name text NOT NULL,
      applied_at timestamptz NOT NULL DEFAULT now()
    )`);
    const done = new Set((await tx.many('SELECT version FROM schema_migrations')).map((row) => row.version));
    const applied = [];
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      await tx.query(migration.sql);
      await tx.query('INSERT INTO schema_migrations (version, name) VALUES ($1, $2)', [migration.version, migration.name]);
      applied.push(migration.name);
      log?.(`[db] миграция применена: ${migration.name}`);
    }
    return applied;
  });
}
