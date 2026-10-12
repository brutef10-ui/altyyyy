// Данные игрока между шагами входа и запросы к REST API сервера.
// Всё хранится в sessionStorage вкладки: код комнаты, фото, ник, токен для переподключения.
import { SERVER_URL } from './config.js';

const STATE_KEY = 'alstudio.player';
const FLASH_KEY = 'alstudio.player.flash';

function read(key) {
  try {
    return JSON.parse(sessionStorage.getItem(key));
  } catch {
    return null;
  }
}

function write(key, value) {
  try {
    if (value === null) sessionStorage.removeItem(key);
    else sessionStorage.setItem(key, JSON.stringify(value));
    return true;
  } catch {
    return false;
  }
}

/** { code, title, photo, nickname, playerId, token } */
export const playerState = {
  get: () => read(STATE_KEY) || {},
  patch(changes) {
    const next = { ...this.get(), ...changes };
    for (const [key, value] of Object.entries(next)) if (value === null || value === undefined) delete next[key];
    write(STATE_KEY, next);
    return next;
  },
  /** Выход из текущей комнаты: фото и ник оставляем, чтобы не вводить заново. */
  leaveRoom() {
    return this.patch({ code: null, title: null, playerId: null, token: null });
  },
};

/** Сообщение для следующей страницы (например, «ник занят»). */
export const flash = {
  set: (message) => write(FLASH_KEY, message),
  take() {
    const message = read(FLASH_KEY);
    write(FLASH_KEY, null);
    return message;
  },
};

export function goTo(page, message) {
  if (message) flash.set(message);
  location.href = page;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export async function api(path, { method = 'GET', body } = {}) {
  let response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    throw new ApiError('Нет связи с сервером. Проверьте интернет и попробуйте ещё раз.');
  }
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(data?.error || `Ошибка сервера (${response.status})`, { status: response.status, code: data?.code });
  }
  return data;
}

// Те же правила проверяет сервер (server/src/validate.js).
export const NICKNAME_MIN = 2;
export const NICKNAME_MAX = 16;

export function normalizeNickname(value) {
  return String(value ?? '').normalize('NFC').replace(/\s+/g, ' ').trim();
}

export function nicknameError(value) {
  const nickname = normalizeNickname(value);
  const length = [...nickname].length;
  if (length < NICKNAME_MIN) return `Минимум ${NICKNAME_MIN} символа`;
  if (length > NICKNAME_MAX) return `Максимум ${NICKNAME_MAX} символов`;
  if (!/^[\p{L}\p{N} _.\-]+$/u.test(nickname)) return 'Можно только буквы, цифры, пробел, «_», «-» и «.»';
  if (!/[\p{L}\p{N}]/u.test(nickname)) return 'Нужна хотя бы одна буква или цифра';
  return null;
}
