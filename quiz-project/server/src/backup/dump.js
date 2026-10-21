// Логический бэкап БД в JSON Lines: одна согласованная транзакция (REPEATABLE READ), строки по курсору,
// поток → gzip → AES-256-GCM → файл. Сессии, лимиты попыток и коды восстановления не сохраняются:
// после восстановления пользователи просто войдут заново.
//
// Строки файла: { header } → { t: таблица, r: строка } … → { manifest: { таблица: { count, sha256 } } }.
// sha256 — по тексту row_to_json каждой строки в порядке первичного ключа: после восстановления
// тот же расчёт по восстановленной базе должен дать те же суммы.
import { createHash } from 'node:crypto';
import { createGunzip, createGzip } from 'node:zlib';
import { Readable } from 'node:stream';
import { encryptToFile, decryptFileStream } from './crypto.js';

// Порядок важен для восстановления (сначала то, на что ссылаются).
export const BACKUP_TABLES = [
  { name: 'accounts', order: 'id' },
  { name: 'visitors', order: 'id' },
  { name: 'visitor_accounts', order: 'visitor_id, account_id' },
  { name: 'settings', order: 'key' },
  { name: 'quizzes', order: 'id' },
  { name: 'images', order: 'id', batch: 10 },
  { name: 'legacy_quizzes', order: 'id' },
  { name: 'events', order: 'id' },
  { name: 'bans', order: 'id' },
  { name: 'admin_audit', order: 'id' },
  { name: 'sharing_hidden', order: 'account_id' },
];

export const FORMAT = 'al-studio-backup';

/** Перебрать строки всех таблиц в одной транзакции: onRow(table, jsonText). */
export async function readTables(db, onRow, { schema = null } = {}) {
  const client = await db.pool.connect();
  const counts = {};
  try {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    if (schema) await client.query(`SET LOCAL search_path TO ${schema}`);
    const version = (await client.query('SELECT max(version) AS v FROM schema_migrations')).rows[0].v;
    for (const table of BACKUP_TABLES) {
      counts[table.name] = 0;
      await client.query(`DECLARE backup_cursor NO SCROLL CURSOR FOR SELECT row_to_json(t)::text AS row FROM ${table.name} t ORDER BY ${table.order}`);
      for (;;) {
        const { rows } = await client.query(`FETCH ${table.batch ?? 500} FROM backup_cursor`);
        for (const { row } of rows) {
          counts[table.name] += 1;
          await onRow(table.name, row);
        }
        if (rows.length === 0) break;
      }
      await client.query('CLOSE backup_cursor');
    }
    await client.query('COMMIT');
    return { schemaVersion: version, counts };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {});
    throw error;
  } finally {
    client.release();
  }
}

/** Суммы таблиц (для сверки после восстановления). */
export async function tableDigests(db, options) {
  const hashes = Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, createHash('sha256')]));
  const { counts, schemaVersion } = await readTables(db, (table, row) => {
    hashes[table].update(row).update('\n');
  }, options);
  return {
    schemaVersion,
    tables: Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, { count: counts[table.name], sha256: hashes[table.name].digest('hex') }])),
  };
}

/** Создать зашифрованный бэкап в файле. Возвращает { manifest, schemaVersion, createdAt }. */
export async function createBackup(db, file, key) {
  const createdAt = new Date().toISOString();
  const hashes = Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, createHash('sha256')]));
  let result = null;
  const lines = Readable.from((async function* generate() {
    const queue = [];
    let wake = null;
    let drained = null;
    let done = false;
    let failure = null;
    // Чтение таблиц идёт параллельно с записью. Очередь ограничена: если запись (gzip, шифрование, диск)
    // не успевает, чтение ждёт — так в памяти не скапливаются, например, сотни картинок.
    const reading = readTables(db, async (table, row) => {
      hashes[table].update(row).update('\n');
      queue.push(`{"t":${JSON.stringify(table)},"r":${row}}\n`);
      wake?.();
      if (queue.length >= 64) await new Promise((resolve) => { drained = resolve; });
    }).then((value) => {
      result = value;
    }, (error) => {
      failure = error;
    }).finally(() => {
      done = true;
      wake?.();
    });
    yield `${JSON.stringify({ header: { format: FORMAT, version: 1, createdAt, tables: BACKUP_TABLES.map((table) => table.name) } })}\n`;
    for (;;) {
      while (queue.length) {
        yield queue.shift();
        if (queue.length < 16 && drained) {
          const release = drained;
          drained = null;
          release();
        }
      }
      if (done) break;
      await new Promise((resolve) => { wake = resolve; });
      wake = null;
    }
    await reading;
    if (failure) throw failure;
    const manifest = Object.fromEntries(BACKUP_TABLES.map((table) => [table.name, { count: result.counts[table.name], sha256: hashes[table.name].digest('hex') }]));
    result.manifest = manifest;
    yield `${JSON.stringify({ manifest, schemaVersion: result.schemaVersion })}\n`;
  })());
  await encryptToFile(lines.pipe(createGzip()), file, key);
  return { manifest: result.manifest, schemaVersion: result.schemaVersion, createdAt };
}

/**
 * Прочитать бэкап построчно: onHeader(header), onRow(table, row), в конце — { manifest, schemaVersion }.
 * Подлинность файла подтверждается только по завершении (тег GCM) — до этого ничего не фиксируйте.
 */
// Строки потока; любая ошибка (подмена файла, неверный ключ, битый gzip) прерывает перебор.
async function* linesOf(stream) {
  let rest = '';
  for await (const chunk of stream) {
    rest += chunk.toString('utf8');
    let index;
    while ((index = rest.indexOf('\n')) !== -1) {
      yield rest.slice(0, index);
      rest = rest.slice(index + 1);
    }
  }
  if (rest) yield rest;
}

export async function readBackup(file, key, options = {}) {
  try {
    return await readBackupUnchecked(file, key, options);
  } catch (error) {
    if (/authenticate|incorrect header check|invalid (stored|distance|code)|unexpected end/i.test(error.message)) {
      throw new Error('Не удалось расшифровать копию: неверный BACKUP_ENCRYPTION_KEY или файл повреждён.');
    }
    throw error;
  }
}

async function readBackupUnchecked(file, key, { onHeader, onRow } = {}) {
  const decrypted = await decryptFileStream(file, key);
  const gunzip = createGunzip();
  decrypted.on('error', (error) => gunzip.destroy(error));
  gunzip.setEncoding('utf8');
  const lines = linesOf(decrypted.pipe(gunzip));
  let header = null;
  let footer = null;
  const hashes = {};
  const counts = {};
  for await (const line of lines) {
    if (!line) continue;
    const item = JSON.parse(line);
    if (item.header) {
      if (item.header.format !== FORMAT) throw new Error('Неизвестный формат бэкапа');
      header = item.header;
      await onHeader?.(header);
    } else if (item.t) {
      // Сумма — по исходному тексту строки, как при создании.
      const raw = line.slice(line.indexOf(',"r":') + 5, -1);
      (hashes[item.t] ??= createHash('sha256')).update(raw).update('\n');
      counts[item.t] = (counts[item.t] ?? 0) + 1;
      await onRow?.(item.t, item.r);
    } else if (item.manifest) {
      footer = item;
    }
  }
  if (!header || !footer) throw new Error('Бэкап неполный: нет заголовка или итоговой сводки.');
  for (const [table, expected] of Object.entries(footer.manifest)) {
    const sha256 = hashes[table]?.digest('hex') ?? createHash('sha256').digest('hex');
    if ((counts[table] ?? 0) !== expected.count || sha256 !== expected.sha256) {
      throw new Error(`Бэкап повреждён: таблица ${table} не совпадает со сводкой.`);
    }
  }
  return { header, manifest: footer.manifest, schemaVersion: footer.schemaVersion };
}
