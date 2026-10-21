// Картинки к вопросам в PostgreSQL (bytea). Раньше лежали файлами на диске, который на Render
// очищается при каждом деплое. Методы — как у ImageStore (src/images.js), но has/read асинхронные.
import { randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { checkImageBuffer } from '../images.js';
import { IMAGE_ID_PATTERN } from '../validate.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export class PgImageStore {
  constructor(db, { maxBytes = 1024 * 1024, maxPerOwner = 500 } = {}) {
    this.db = db;
    this.maxBytes = maxBytes;
    this.maxPerOwner = maxPerOwner;
  }

  async init() {}

  async has(id) {
    if (typeof id !== 'string' || !IMAGE_ID_PATTERN.test(id)) return false;
    return Boolean(await this.db.one('SELECT 1 FROM images WHERE id = $1', [id]));
  }

  async save(ownerId, buffer, type) {
    checkImageBuffer(buffer, type, this.maxBytes);
    if (!UUID.test(ownerId)) throw new AppError('Войдите в аккаунт, чтобы продолжить.', { status: 401, code: 'UNAUTHORIZED' });
    const { n } = await this.db.one('SELECT count(*)::int AS n FROM images WHERE account_id = $1', [ownerId]);
    if (n >= this.maxPerOwner) {
      throw new AppError('Слишком много картинок. Удалите ненужные игры.', { status: 409, code: 'TOO_MANY_IMAGES' });
    }
    const id = randomBytes(16).toString('hex');
    const row = await this.db.one(
      'INSERT INTO images (id, account_id, content_type, bytes, size) VALUES ($1, $2, $3, $4, $5) RETURNING created_at',
      [id, ownerId, type, buffer, buffer.length],
    );
    return { id, ownerId, type, size: buffer.length, createdAt: new Date(row.created_at).toISOString() };
  }

  /** { type, bytes } или null. */
  async read(id) {
    if (typeof id !== 'string' || !IMAGE_ID_PATTERN.test(id)) return null;
    const row = await this.db.one('SELECT content_type, bytes FROM images WHERE id = $1', [id]);
    return row ? { type: row.content_type, bytes: row.bytes } : null;
  }

  /** Файлового пути у картинок в БД нет — используйте read(). */
  locate() {
    return null;
  }

  async collectGarbage(referenced, minAgeMs) {
    const { rowCount } = await this.db.query(
      'DELETE FROM images WHERE created_at < now() - make_interval(secs => $1) AND NOT (id = ANY($2::text[]))',
      [minAgeMs / 1000, [...referenced]],
    );
    return rowCount;
  }
}
