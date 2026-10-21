// Восстановление бэкапа в БД (или в отдельную схему для проверки).
// Всё в одной транзакции: если файл подменён, повреждён или не сходится со сводкой — ничего не сохраняется.
import { randomBytes } from 'node:crypto';
import { createDb } from '../db/index.js';
import { migrate } from '../db/migrate.js';
import { BACKUP_TABLES, readBackup, tableDigests } from './dump.js';

const BATCH = Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, table.batch ?? 300]));
const SERIAL = { events: 'id', admin_audit: 'id' };

async function insertRows(tx, table, rows) {
  if (!rows.length) return;
  // Только столбцы из бэкапа: новые столбцы (добавленные миграциями позже) получат значения по умолчанию.
  const columns = Object.keys(rows[0]);
  const list = columns.map((column) => `"${column.replace(/"/g, '""')}"`).join(', ');
  await tx.query(`INSERT INTO ${table} (${list}) SELECT ${list} FROM json_populate_recordset(NULL::${table}, $1::json)`, [JSON.stringify(rows)]);
}

/**
 * Восстановить файл бэкапа в db. Целевая база должна быть пустой (без аккаунтов и событий),
 * если не указано allowNonEmpty. Возвращает { manifest, schemaVersion, counts }.
 */
export async function restoreBackup(db, file, key, { allowNonEmpty = false, log = null } = {}) {
  await migrate(db, { log });
  if (!allowNonEmpty) {
    const { n } = await db.one('SELECT (SELECT count(*) FROM accounts) + (SELECT count(*) FROM events) + (SELECT count(*) FROM quizzes) AS n');
    if (Number(n) > 0) throw new Error('Целевая база не пуста. Восстанавливайте в новую пустую базу (или в отдельную схему для проверки).');
  }
  return db.tx(async (tx) => {
    const pending = new Map();
    const counts = {};
    const flush = async (table) => {
      const rows = pending.get(table);
      if (rows?.length) await insertRows(tx, table, rows.splice(0));
    };
    let current = null;
    const result = await readBackup(file, key, {
      onRow: async (table, row) => {
        if (!BATCH[table]) throw new Error(`Неизвестная таблица в бэкапе: ${table}`);
        if (current && current !== table) await flush(current);
        current = table;
        if (!pending.has(table)) pending.set(table, []);
        pending.get(table).push(row);
        counts[table] = (counts[table] ?? 0) + 1;
        if (pending.get(table).length >= BATCH[table]) await flush(table);
      },
    });
    if (current) await flush(current);
    for (const [table, column] of Object.entries(SERIAL)) {
      await tx.query(`SELECT setval(pg_get_serial_sequence('${table}', '${column}'), GREATEST((SELECT max(${column}) FROM ${table}), 1))`);
    }
    return { ...result, counts };
  });
}

/**
 * Проверка восстановления: развернуть бэкап во временную схему, пересчитать суммы таблиц по восстановленным
 * данным и сравнить со сводкой бэкапа. Схема удаляется в любом случае.
 */
export async function restoreCheck({ url, ssl, file, key, log = console.log }) {
  const schema = `restore_check_${randomBytes(4).toString('hex')}`;
  const db = createDb({ url, ssl, schema, max: 2, statementTimeoutMs: 120_000, applicationName: 'al-studio-restore-check' });
  const started = Date.now();
  try {
    const restored = await restoreBackup(db, file, key, { log: null });
    const digests = await tableDigests(db);
    const problems = [];
    for (const [table, expected] of Object.entries(restored.manifest)) {
      const actual = digests.tables[table];
      if (!actual || actual.count !== expected.count || actual.sha256 !== expected.sha256) {
        problems.push(`${table}: в бэкапе ${expected.count}, восстановлено ${actual?.count ?? 0}${actual && actual.count === expected.count ? ' (содержимое отличается)' : ''}`);
      }
    }
    const total = Object.values(restored.manifest).reduce((sum, item) => sum + item.count, 0);
    log?.(problems.length
      ? `[restore-check] НЕ СОВПАДАЕТ: ${problems.join('; ')}`
      : `[restore-check] OK: восстановлено строк ${total}, все ${Object.keys(restored.manifest).length} таблиц совпадают (${Date.now() - started} мс).`);
    return { ok: problems.length === 0, problems, total, manifest: restored.manifest };
  } finally {
    await db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await db.close();
  }
}
