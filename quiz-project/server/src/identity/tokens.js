// Случайные токены и их хэши. В БД хранится только SHA-256 токена: утечка базы не даёт войти.
// Токены 256-битные случайные, поэтому «соль» и медленный хэш им не нужны.
import { createHash, randomBytes, randomInt, timingSafeEqual } from 'node:crypto';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

export const newToken = () => randomBytes(32).toString('base64url');
export const isToken = (value) => typeof value === 'string' && TOKEN_PATTERN.test(value);
export const sha256 = (value) => createHash('sha256').update(value).digest();

export function safeEqual(a, b) {
  const left = Buffer.from(String(a));
  const right = Buffer.from(String(b));
  return left.length === right.length && timingSafeEqual(left, right);
}

// Код для людей: без похожих символов (0/O, 1/I/L, U/V), группы по 5 через дефис.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTWXYZ23456789';

export function newHumanCode(length) {
  let code = '';
  for (let i = 0; i < length; i += 1) code += CODE_ALPHABET[randomInt(CODE_ALPHABET.length)];
  return code.match(/.{1,5}/g).join('-');
}

/** Код в том виде, в каком его хэшируем: без пробелов и дефисов, заглавными. */
export const normalizeHumanCode = (value) => String(value ?? '').toUpperCase().replace(/[^A-Z0-9]/g, '');
