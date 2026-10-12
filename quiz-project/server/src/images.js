// Картинки к вопросам. Файлы лежат рядом с quizzes.json в папке images/, список — в images/index.json.
// В игре хранится только id картинки, поэтому сообщения Socket.IO остаются маленькими,
// а игроки загружают картинку обычным HTTP-запросом (с долгим кэшем).
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { AppError } from './errors.js';
import { IMAGE_ID_PATTERN } from './validate.js';

const TYPES = {
  'image/jpeg': { ext: 'jpg', check: (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff },
  'image/png': { ext: 'png', check: (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) },
  'image/webp': { ext: 'webp', check: (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP' },
};

export const IMAGE_TYPES = Object.freeze(Object.keys(TYPES));

export class ImageStore {
  #index = new Map(); // id → { id, ownerId, type, size, createdAt }
  #queue = Promise.resolve();

  constructor(dir, { maxBytes = 1024 * 1024, maxPerOwner = 500 } = {}) {
    this.dir = dir;
    this.indexFile = path.join(dir, 'index.json');
    this.maxBytes = maxBytes;
    this.maxPerOwner = maxPerOwner;
  }

  async init() {
    await fs.mkdir(this.dir, { recursive: true });
    try {
      const data = JSON.parse(await fs.readFile(this.indexFile, 'utf8'));
      for (const item of Array.isArray(data.images) ? data.images : []) {
        if (IMAGE_ID_PATTERN.test(item.id) && TYPES[item.type]) this.#index.set(item.id, item);
      }
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${this.indexFile}: ${error.message}`);
    }
  }

  #fileOf(item) {
    return path.join(this.dir, `${item.id}.${TYPES[item.type].ext}`);
  }

  #persist() {
    const run = this.#queue.then(async () => {
      const temp = `${this.indexFile}.${process.pid}.tmp`;
      await fs.writeFile(temp, `${JSON.stringify({ images: [...this.#index.values()] }, null, 2)}\n`, 'utf8');
      await fs.rename(temp, this.indexFile);
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  has(id) {
    return typeof id === 'string' && this.#index.has(id);
  }

  /** Сохраняет картинку после проверки формата по содержимому файла. */
  async save(ownerId, buffer, type) {
    const kind = TYPES[type];
    if (!kind || !Buffer.isBuffer(buffer) || buffer.length < 16 || !kind.check(buffer)) {
      throw new AppError('Картинка должна быть в формате JPEG, PNG или WebP', { status: 415, code: 'BAD_IMAGE' });
    }
    if (buffer.length > this.maxBytes) {
      throw new AppError('Картинка больше 1 МБ', { status: 413, code: 'IMAGE_TOO_LARGE' });
    }
    const owned = [...this.#index.values()].filter((item) => item.ownerId === ownerId).length;
    if (owned >= this.maxPerOwner) {
      throw new AppError('Слишком много картинок. Удалите ненужные игры.', { status: 409, code: 'TOO_MANY_IMAGES' });
    }

    let id;
    do id = randomBytes(16).toString('hex'); while (this.#index.has(id));
    const item = { id, ownerId, type, size: buffer.length, createdAt: new Date().toISOString() };
    await fs.writeFile(this.#fileOf(item), buffer);
    this.#index.set(id, item);
    await this.#persist();
    return item;
  }

  /** { path, type } для отдачи файла или null. */
  locate(id) {
    const item = IMAGE_ID_PATTERN.test(id) ? this.#index.get(id) : null;
    return item ? { path: this.#fileOf(item), type: item.type } : null;
  }

  /**
   * Удаляет картинки, на которые не ссылается ни одна сохранённая игра и ни одна активная комната,
   * если они старше minAgeMs (картинки из несохранённого черновика не должны пропасть сразу).
   */
  async collectGarbage(referenced, minAgeMs) {
    const now = Date.now();
    const stale = [...this.#index.values()].filter((item) => !referenced.has(item.id) && now - Date.parse(item.createdAt) > minAgeMs);
    if (stale.length === 0) return 0;
    for (const item of stale) {
      this.#index.delete(item.id);
      await fs.rm(this.#fileOf(item), { force: true }).catch(() => {});
    }
    await this.#persist();
    return stale.length;
  }
}
