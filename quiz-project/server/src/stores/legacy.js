// Игры и картинки, сохранённые до появления аккаунтов (data/quizzes.json и data/images/).
//
// importLegacyData() при старте копирует их в БД (повторный запуск ничего не дублирует).
// Владелец старой игры — хэш токена браузера ('device:…'). Забрать игры в аккаунт может только тот,
// у кого в браузере остался сам токен: claim() вызывается с владельцем, вычисленным из токена на сервере.
import { promises as fs } from 'node:fs';
import { JsonQuizStore } from '../quizzes.js';
import { ImageStore } from '../images.js';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

async function exists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function importLegacyData(db, { dataFile, imagesDir, maxImageBytes, log = console.log }) {
  let quizzes = 0;
  let images = 0;
  if (await exists(dataFile)) {
    const store = new JsonQuizStore(dataFile);
    await store.init();
    for (const quiz of await store.listAll()) {
      if (!UUID.test(quiz.id) || typeof quiz.ownerId !== 'string' || !quiz.ownerId.startsWith('device:')) continue;
      const data = { ...quiz };
      for (const key of ['id', 'ownerId', 'createdAt', 'updatedAt']) delete data[key];
      const { rowCount } = await db.query(
        `INSERT INTO legacy_quizzes (id, device_owner, title, data, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [quiz.id, quiz.ownerId, String(quiz.title ?? ''), data, quiz.createdAt || new Date().toISOString(), quiz.updatedAt || new Date().toISOString()],
      );
      quizzes += rowCount;
    }
  }
  if (await exists(imagesDir)) {
    const store = new ImageStore(imagesDir, { maxBytes: maxImageBytes });
    await store.init();
    for (const item of store.list()) {
      const file = await store.read(item.id);
      if (!file) continue;
      const { rowCount } = await db.query(
        `INSERT INTO images (id, legacy_owner, content_type, bytes, size, created_at)
         VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
        [item.id, typeof item.ownerId === 'string' ? item.ownerId : null, file.type, file.bytes, file.bytes.length, item.createdAt || new Date().toISOString()],
      );
      images += rowCount;
    }
  }
  if (quizzes || images) log?.(`[db] перенесено из старых файлов: игр — ${quizzes}, картинок — ${images}`);
  return { quizzes, images };
}

export class LegacyService {
  constructor(db) {
    this.db = db;
  }

  async count(deviceOwnerId) {
    const row = await this.db.one('SELECT count(*)::int AS n FROM legacy_quizzes WHERE device_owner = $1 AND claimed_at IS NULL', [deviceOwnerId]);
    return row.n;
  }

  /** Перенести игры устройства в аккаунт. Возвращает число перенесённых игр. */
  async claim(deviceOwnerId, accountId) {
    return this.db.tx(async (tx) => {
      const rows = await tx.many(
        'SELECT id, title, data, created_at, updated_at FROM legacy_quizzes WHERE device_owner = $1 AND claimed_at IS NULL FOR UPDATE',
        [deviceOwnerId],
      );
      for (const row of rows) {
        await tx.query(
          `INSERT INTO quizzes (id, account_id, title, data, created_at, updated_at)
           VALUES ($1, $2, $3, $4, $5, $6) ON CONFLICT (id) DO NOTHING`,
          [row.id, accountId, row.title, row.data, row.created_at, row.updated_at],
        );
      }
      await tx.query('UPDATE legacy_quizzes SET claimed_by = $2, claimed_at = now() WHERE device_owner = $1 AND claimed_at IS NULL', [deviceOwnerId, accountId]);
      await tx.query('UPDATE images SET account_id = $2 WHERE legacy_owner = $1 AND account_id IS NULL', [deviceOwnerId, accountId]);
      return rows.length;
    });
  }
}
