// Проверка всех данных, которые приходят от клиентов. Клиентам не доверяем.

export const ROOM_CODE_LENGTH = 6;
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 16;
export const MAX_PHOTO_BYTES = 100 * 1024;
const MIN_PHOTO_BYTES = 64;

export const QUIZ_LIMITS = Object.freeze({
  titleMax: 80,
  questionsMin: 1,
  questionsMax: 50,
  questionMax: 200,
  answersMin: 2,
  answersMax: 4,
  answerMax: 80,
  timeLimits: Object.freeze([5, 10, 15, 20, 30, 45, 60, 90, 120]),
  defaultTimeLimit: 20,
});

const ok = (value) => ({ ok: true, value });
const fail = (error) => ({ ok: false, error });

export function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

const charCount = (text) => [...text].length;

// Убираем управляющие символы, приводим Юникод к одной форме и обрезаем пробелы.
function cleanText(value, { multiline = false } = {}) {
  if (typeof value !== 'string') return '';
  let text = value.normalize('NFC').replace(/[\u0000-\u0009\u000B-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, (char) => (char === '\t' ? ' ' : ''));
  text = multiline ? text.replace(/\r\n?/g, '\n').replace(/\n{3,}/g, '\n\n') : text.replace(/[\r\n]+/g, ' ');
  return text.replace(/[ ]{2,}/g, ' ').trim();
}

// ---------- Комната ----------

export function validateRoomCode(value) {
  const code = typeof value === 'number' ? String(value) : typeof value === 'string' ? value.replace(/\s+/g, '') : '';
  if (!/^\d{6}$/.test(code)) return fail('Код комнаты — это 6 цифр');
  return ok(code);
}

// ---------- Ник ----------

const NICKNAME_CHARS = /^[\p{L}\p{N} _.\-]+$/u;
const HAS_LETTER_OR_DIGIT = /[\p{L}\p{N}]/u;

export function normalizeNickname(value) {
  return cleanText(value).replace(/\s+/g, ' ');
}

// Ключ для проверки уникальности: регистр и «ё/е» не различаем.
export function nicknameKey(nickname) {
  return normalizeNickname(nickname).toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

export function validateNickname(value) {
  if (typeof value !== 'string') return fail('Введите ник');
  const nickname = normalizeNickname(value);
  const length = charCount(nickname);
  if (length < NICKNAME_MIN) return fail(`Ник должен быть не короче ${NICKNAME_MIN} символов`);
  if (length > NICKNAME_MAX) return fail(`Ник должен быть не длиннее ${NICKNAME_MAX} символов`);
  if (!NICKNAME_CHARS.test(nickname)) return fail('В нике можно использовать только буквы, цифры, пробел, «_», «-» и «.»');
  if (!HAS_LETTER_OR_DIGIT.test(nickname)) return fail('В нике должна быть хотя бы одна буква или цифра');
  return ok(nickname);
}

// ---------- Фото ----------

const PHOTO_DATA_URL = /^data:image\/(jpeg|png);base64,([A-Za-z0-9+/]+={0,2})$/;
const MAX_PHOTO_DATA_URL_LENGTH = 'data:image/jpeg;base64,'.length + Math.ceil(MAX_PHOTO_BYTES / 3) * 4;

function hasSignature(bytes, type) {
  if (type === 'jpeg') return bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  return bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
}

export function validatePhoto(value) {
  if (typeof value !== 'string' || value.length === 0) return fail('Сделайте селфи — без фото войти нельзя');
  if (value.length > MAX_PHOTO_DATA_URL_LENGTH) return fail('Фото слишком большое (максимум 100 КБ)');
  const match = PHOTO_DATA_URL.exec(value);
  if (!match) return fail('Фото должно быть в формате JPEG или PNG');
  const [, type, base64] = match;
  if (base64.length % 4 !== 0) return fail('Фото повреждено');
  const bytes = Buffer.from(base64, 'base64');
  if (bytes.length > MAX_PHOTO_BYTES) return fail('Фото слишком большое (максимум 100 КБ)');
  if (bytes.length < MIN_PHOTO_BYTES || !hasSignature(bytes, type)) return fail('Фото повреждено или не является JPEG/PNG');
  return ok(value);
}

// ---------- Ответ ----------

export function validateAnswerIndex(value, answersCount) {
  if (!Number.isInteger(value) || value < 0 || value >= answersCount) return fail('Некорректный вариант ответа');
  return ok(value);
}

// ---------- Игра (квиз) ----------

export function validateQuiz(input) {
  if (!isPlainObject(input)) return { ok: false, errors: ['Некорректные данные игры'] };
  const L = QUIZ_LIMITS;
  const errors = [];

  const title = cleanText(input.title);
  if (!title) errors.push('Укажите название игры');
  else if (charCount(title) > L.titleMax) errors.push(`Название длиннее ${L.titleMax} символов`);

  const rawQuestions = Array.isArray(input.questions) ? input.questions : [];
  if (rawQuestions.length < L.questionsMin) errors.push('Добавьте хотя бы один вопрос');
  if (rawQuestions.length > L.questionsMax) errors.push(`Вопросов не может быть больше ${L.questionsMax}`);

  const questions = rawQuestions.slice(0, L.questionsMax).map((raw, index) => {
    const label = `Вопрос ${index + 1}`;
    if (!isPlainObject(raw)) {
      errors.push(`${label}: некорректные данные`);
      return null;
    }

    const text = cleanText(raw.text, { multiline: true });
    if (!text) errors.push(`${label}: введите текст вопроса`);
    else if (charCount(text) > L.questionMax) errors.push(`${label}: текст длиннее ${L.questionMax} символов`);

    const rawAnswers = Array.isArray(raw.answers) ? raw.answers : [];
    if (rawAnswers.length < L.answersMin || rawAnswers.length > L.answersMax) {
      errors.push(`${label}: нужно от ${L.answersMin} до ${L.answersMax} вариантов ответа`);
    }
    const answers = rawAnswers.slice(0, L.answersMax).map((answer, answerIndex) => {
      const answerText = cleanText(answer);
      if (!answerText) errors.push(`${label}: заполните вариант ${answerIndex + 1}`);
      else if (charCount(answerText) > L.answerMax) errors.push(`${label}: вариант ${answerIndex + 1} длиннее ${L.answerMax} символов`);
      return answerText;
    });

    const correct = raw.correct;
    if (!Number.isInteger(correct) || correct < 0 || correct >= answers.length) {
      errors.push(`${label}: отметьте правильный ответ`);
    }

    const timeLimit = raw.timeLimit;
    if (!L.timeLimits.includes(timeLimit)) {
      errors.push(`${label}: время на ответ должно быть одним из значений: ${L.timeLimits.join(', ')} сек.`);
    }

    return { text, answers, correct, timeLimit };
  });

  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { title, questions } };
}
