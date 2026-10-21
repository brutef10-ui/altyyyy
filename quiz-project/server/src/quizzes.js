// Сохранённые игры (CRUD).
//
// QuizService — бизнес-логика (проверка данных, права владельца).
// Хранилище — объект с методами listAll, listByOwner, findById, insert, update, remove
// (необязательные: countByOwner, imageIds). Сервер использует PgQuizStore (stores/pgQuizStore.js,
// PostgreSQL); JsonQuizStore (JSON-файл) остаётся для тестов и переноса старых данных.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { AppError, notFound } from './errors.js';
import { quizImageIds, validateQuiz } from './validate.js';

const ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

export class JsonQuizStore {
  #data = null;
  #queue = Promise.resolve();

  constructor(filePath) {
    this.filePath = filePath;
  }

  async init() {
    await fs.mkdir(path.dirname(this.filePath), { recursive: true });
    try {
      const parsed = JSON.parse(await fs.readFile(this.filePath, 'utf8'));
      this.#data = { version: 1, quizzes: Array.isArray(parsed.quizzes) ? parsed.quizzes : [] };
    } catch (error) {
      if (error.code !== 'ENOENT') throw new Error(`Не удалось прочитать ${this.filePath}: ${error.message}`);
      this.#data = { version: 1, quizzes: [] };
      await this.#persist();
    }
  }

  // Запись через временный файл и rename: файл не повредится, если процесс упадёт посреди записи.
  async #persist() {
    const temp = `${this.filePath}.${process.pid}.tmp`;
    await fs.writeFile(temp, `${JSON.stringify(this.#data, null, 2)}\n`, 'utf8');
    await fs.rename(temp, this.filePath);
  }

  // Изменения выполняются строго по очереди, чтобы параллельные запросы не затёрли друг друга.
  #mutate(change) {
    const run = this.#queue.then(async () => {
      const result = change(this.#data.quizzes);
      await this.#persist();
      return result;
    });
    this.#queue = run.catch(() => {});
    return run;
  }

  async listAll() {
    return this.#data.quizzes.map((quiz) => structuredClone(quiz));
  }

  async listByOwner(ownerId) {
    return this.#data.quizzes.filter((quiz) => quiz.ownerId === ownerId).map((quiz) => structuredClone(quiz));
  }

  async findById(id) {
    const quiz = this.#data.quizzes.find((item) => item.id === id);
    return quiz ? structuredClone(quiz) : null;
  }

  async insert(quiz) {
    return this.#mutate((quizzes) => {
      quizzes.push(structuredClone(quiz));
      return structuredClone(quiz);
    });
  }

  async update(id, changes) {
    return this.#mutate((quizzes) => {
      const index = quizzes.findIndex((item) => item.id === id);
      if (index === -1) return null;
      quizzes[index] = { ...quizzes[index], ...structuredClone(changes), id };
      return structuredClone(quizzes[index]);
    });
  }

  async remove(id) {
    return this.#mutate((quizzes) => {
      const index = quizzes.findIndex((item) => item.id === id);
      if (index === -1) return false;
      quizzes.splice(index, 1);
      return true;
    });
  }
}

function toSummary(quiz) {
  return {
    id: quiz.id,
    title: quiz.title,
    questionCount: quiz.questions.length,
    createdAt: quiz.createdAt,
    updatedAt: quiz.updatedAt,
  };
}

// ownerId — внутреннее поле, клиенту не отдаём.
function toPublic(quiz) {
  const copy = { ...quiz };
  delete copy.ownerId;
  return copy;
}

function checkQuiz(input) {
  const result = validateQuiz(input);
  if (!result.ok) {
    throw new AppError(result.errors[0], { status: 422, code: 'INVALID_QUIZ', details: result.errors });
  }
  return result.value;
}

export class QuizService {
  constructor(store, { images = null, maxQuizzesPerOwner = 200 } = {}) {
    this.store = store;
    this.images = images;
    this.maxQuizzesPerOwner = maxQuizzesPerOwner;
  }

  // has() у файлового хранилища синхронный, у хранилища в БД — асинхронный; await подходит обоим.
  async #checkImages(quiz) {
    if (!this.images) return;
    for (const id of quizImageIds(quiz)) {
      if (!(await this.images.has(id))) {
        throw new AppError('Одна из картинок не найдена на сервере — загрузите её заново', { status: 422, code: 'IMAGE_MISSING' });
      }
    }
  }

  /** id картинок всех сохранённых игр — чтобы не удалить используемые. */
  async referencedImageIds() {
    if (typeof this.store.imageIds === 'function') return this.store.imageIds();
    const quizzes = await this.store.listAll();
    return new Set(quizzes.flatMap(quizImageIds));
  }

  async list(ownerId) {
    const quizzes = await this.store.listByOwner(ownerId);
    return quizzes.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).map(toSummary);
  }

  async #findOwned(ownerId, id) {
    const quiz = typeof id === 'string' && ID_PATTERN.test(id) ? await this.store.findById(id) : null;
    // Чужую игру отдаём как «не найдена», чтобы не раскрывать, что такой id существует.
    if (!quiz || quiz.ownerId !== ownerId) throw notFound('Игра не найдена');
    return quiz;
  }

  async get(ownerId, id) {
    return toPublic(await this.#findOwned(ownerId, id));
  }

  async create(ownerId, input) {
    const data = checkQuiz(input);
    await this.#checkImages(data);
    const count = typeof this.store.countByOwner === 'function'
      ? await this.store.countByOwner(ownerId)
      : (await this.store.listByOwner(ownerId)).length;
    if (count >= this.maxQuizzesPerOwner) {
      throw new AppError(`Можно сохранить не больше ${this.maxQuizzesPerOwner} игр`, { status: 409, code: 'TOO_MANY_QUIZZES' });
    }
    const now = new Date().toISOString();
    const quiz = { id: randomUUID(), ownerId, ...data, createdAt: now, updatedAt: now };
    return toPublic(await this.store.insert(quiz));
  }

  async update(ownerId, id, input) {
    await this.#findOwned(ownerId, id);
    const data = checkQuiz(input);
    await this.#checkImages(data);
    const updated = await this.store.update(id, { ...data, updatedAt: new Date().toISOString() });
    if (!updated) throw notFound('Игра не найдена');
    return toPublic(updated);
  }

  async remove(ownerId, id) {
    await this.#findOwned(ownerId, id);
    await this.store.remove(id);
  }
}
