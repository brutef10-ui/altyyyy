// Хранилище сохранённых игр в PostgreSQL. Те же методы, что у JsonQuizStore (src/quizzes.js),
// поэтому QuizService работает с ним без изменений. Владелец игры — account_id (UUID аккаунта).
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (value) => typeof value === 'string' && UUID.test(value);

const COLUMNS = 'id, account_id, data, created_at, updated_at';

function toQuiz(row) {
  return {
    ...row.data,
    id: row.id,
    ownerId: row.account_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

// В jsonb храним всё, кроме служебных полей (они в отдельных столбцах).
function dataOf(quiz) {
  const data = { ...quiz };
  for (const key of ['id', 'ownerId', 'createdAt', 'updatedAt']) delete data[key];
  return data;
}

export class PgQuizStore {
  constructor(db) {
    this.db = db;
  }

  async init() {}

  async listAll() {
    return (await this.db.many(`SELECT ${COLUMNS} FROM quizzes`)).map(toQuiz);
  }

  async listByOwner(ownerId) {
    if (!isUuid(ownerId)) return [];
    return (await this.db.many(`SELECT ${COLUMNS} FROM quizzes WHERE account_id = $1 ORDER BY updated_at DESC`, [ownerId])).map(toQuiz);
  }

  async countByOwner(ownerId) {
    if (!isUuid(ownerId)) return 0;
    return (await this.db.one('SELECT count(*)::int AS n FROM quizzes WHERE account_id = $1', [ownerId])).n;
  }

  async findById(id) {
    if (!isUuid(id)) return null;
    const row = await this.db.one(`SELECT ${COLUMNS} FROM quizzes WHERE id = $1`, [id]);
    return row ? toQuiz(row) : null;
  }

  async insert(quiz) {
    const row = await this.db.one(
      `INSERT INTO quizzes (id, account_id, title, data, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING ${COLUMNS}`,
      [quiz.id, quiz.ownerId, String(quiz.title ?? ''), dataOf(quiz), quiz.createdAt, quiz.updatedAt],
    );
    return toQuiz(row);
  }

  // Как в JsonQuizStore: поля changes заменяют прежние, остальные сохраняются.
  async update(id, changes) {
    if (!isUuid(id)) return null;
    const data = dataOf(changes);
    const row = await this.db.one(
      `UPDATE quizzes SET data = data || $2::jsonb,
              title = COALESCE($3, title),
              updated_at = COALESCE($4::timestamptz, now())
        WHERE id = $1 RETURNING ${COLUMNS}`,
      [id, data, typeof changes.title === 'string' ? changes.title : null, changes.updatedAt ?? null],
    );
    return row ? toQuiz(row) : null;
  }

  async remove(id) {
    if (!isUuid(id)) return false;
    const { rowCount } = await this.db.query('DELETE FROM quizzes WHERE id = $1', [id]);
    return rowCount > 0;
  }

  /** id картинок всех игр, включая ещё не перенесённые старые игры (их картинки удалять нельзя). */
  async imageIds() {
    const rows = await this.db.many(
      `SELECT DISTINCT q->>'image' AS id FROM (
         SELECT jsonb_array_elements(data->'questions') AS q FROM quizzes
         UNION ALL
         SELECT jsonb_array_elements(data->'questions') FROM legacy_quizzes WHERE claimed_at IS NULL
       ) items WHERE q->>'image' IS NOT NULL`,
    );
    return new Set(rows.map((row) => row.id));
  }
}
