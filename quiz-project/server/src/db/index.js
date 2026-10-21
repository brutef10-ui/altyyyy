// Подключение к PostgreSQL.
//
// Весь остальной код работает с БД только через этот объект: query / one / many / tx.
// Запросы — только параметризованные ($1, $2, …), строки в SQL не склеиваются.
// Чтобы перейти на другую СУБД, достаточно реализовать те же методы.
import pg from 'pg';

// bigint (bigserial, count(*)) приходит строкой — для счётчиков в пределах Number это неудобно.
pg.types.setTypeParser(pg.types.builtins.INT8, (value) => {
  const number = Number(value);
  return Number.isSafeInteger(number) ? number : value;
});

function sslOption(mode) {
  if (!mode || mode === 'disable' || mode === 'false') return false;
  // Внутренняя сеть Render и большинство облачных БД используют сертификаты, которых нет в системном
  // хранилище контейнера, поэтому 'require' шифрует соединение без проверки цепочки; 'verify' — с проверкой.
  if (mode === 'verify') return { rejectUnauthorized: true };
  return { rejectUnauthorized: false };
}

export function createDb({ url, ssl, schema, max = 10, statementTimeoutMs = 15_000, applicationName = 'luminous' }) {
  if (!url) throw new Error('Не задан DATABASE_URL — адрес базы PostgreSQL (см. .env.example).');
  const options = [];
  if (schema) {
    if (!/^[a-z_][a-z0-9_]{0,62}$/.test(schema)) throw new Error('Некорректное имя схемы БД');
    options.push(`-c search_path=${schema}`);
  }
  const pool = new pg.Pool({
    connectionString: url,
    ssl: sslOption(ssl),
    max,
    idleTimeoutMillis: 30_000,
    connectionTimeoutMillis: 10_000,
    statement_timeout: statementTimeoutMs,
    application_name: applicationName,
    options: options.join(' ') || undefined,
  });
  // Ошибка простаивающего соединения (БД перезапустилась) не должна ронять процесс: пул создаст новое.
  pool.on('error', (error) => console.error('[db] соединение прервано:', error.message));

  const wrap = (runner) => ({
    query: (text, params) => runner.query(text, params),
    async one(text, params) {
      const { rows } = await runner.query(text, params);
      return rows[0] ?? null;
    },
    async many(text, params) {
      const { rows } = await runner.query(text, params);
      return rows;
    },
  });

  const db = {
    ...wrap(pool),
    pool,
    schema: schema || null,

    /** Выполнить fn(tx) в транзакции. Ошибка внутри — откат. */
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn({ ...wrap(client), client });
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    async ping() {
      await pool.query('SELECT 1');
      return true;
    },

    close() {
      return pool.end();
    },
  };
  return db;
}

/** Ошибка нарушения уникальности (например, логин уже занят). */
export const isUniqueViolation = (error, constraint) =>
  error?.code === '23505' && (!constraint || error.constraint === constraint);
