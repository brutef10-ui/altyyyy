// REST API сервера: сохранённые игры ведущего.
// Владельца определяет сервер по cookie сессии (credentials: 'include'); изменяющие запросы
// дополнительно несут CSRF-токен. Без входа сервер отвечает 401 — тогда открываем страницу входа.
import { SERVER_URL } from './config.js';
import { csrfToken, goToLogin, loadSession } from './auth.js';

const TOKEN_KEY = 'alstudio.host.token';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

// Токен браузера ведущего из времён до аккаунтов. Доступа к играм он больше не даёт:
// по нему сервер только находит старые игры этого браузера, чтобы перенести их в аккаунт.
export function getHostToken() {
  let token = null;
  try {
    token = localStorage.getItem(TOKEN_KEY);
  } catch {
    // localStorage может быть недоступен (приватный режим) — создадим токен на эту сессию.
  }
  if (!TOKEN_PATTERN.test(token || '')) {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    token = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
    try {
      localStorage.setItem(TOKEN_KEY, token);
    } catch {
      /* без сохранения */
    }
  }
  return token;
}

export class ApiError extends Error {
  constructor(message, { status = 0, code = null, details = null } = {}) {
    super(message);
    this.status = status;
    this.code = code;
    this.details = details;
  }
}

/** Старый токен этого браузера, если он есть (новый не создаём). */
function existingDeviceToken() {
  try {
    const token = localStorage.getItem(TOKEN_KEY);
    return TOKEN_PATTERN.test(token || '') ? token : null;
  } catch {
    return null;
  }
}

export function forgetDeviceToken() {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* недоступно */
  }
}

const unreachable = () => new ApiError(`Сервер недоступен (${SERVER_URL}). Проверьте, что он запущен.`);

// Запрос с cookie сессии. Изменяющим запросам — CSRF-токен; если он устарел (сервер перезапущен
// без постоянного секрета), берём новый и повторяем один раз.
async function send(path, { method = 'GET', headers = {}, body } = {}, retried = false) {
  const all = { ...headers };
  if (method !== 'GET') {
    if (!csrfToken()) await loadSession().catch(() => {});
    all['X-CSRF-Token'] = csrfToken() ?? '';
  }
  let response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, { method, headers: all, body, credentials: 'include' });
  } catch {
    throw unreachable();
  }
  if (response.status === 403 && !retried) {
    const data = await response.clone().json().catch(() => null);
    if (data?.code === 'CSRF') {
      await loadSession({ force: true }).catch(() => {});
      return send(path, { method, headers, body }, true);
    }
  }
  return response;
}

async function request(path, { method = 'GET', body, auth = true, headers = {} } = {}) {
  const all = { ...headers };
  if (body !== undefined) all['Content-Type'] = 'application/json';
  const response = await send(path, { method, headers: all, body: body === undefined ? undefined : JSON.stringify(body) });

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (response.status === 401 && auth) goToLogin();
  if (!response.ok) {
    throw new ApiError(data?.error || `Ошибка сервера (${response.status})`, {
      status: response.status,
      code: data?.code,
      details: data?.details,
    });
  }
  return data;
}

/** Адрес картинки вопроса по её id (картинки отдаёт сервер). */
export function imageUrl(id) {
  return id ? `${SERVER_URL}/api/images/${encodeURIComponent(id)}` : '';
}

/** Загружает картинку (Blob/File JPEG, PNG или WebP до 1 МБ). Возвращает { id, url }. */
async function uploadImage(blob) {
  const response = await send('/api/images', { method: 'POST', headers: { 'Content-Type': blob.type || 'image/jpeg' }, body: blob });
  const data = await response.json().catch(() => null);
  if (response.status === 401) goToLogin();
  if (!response.ok) throw new ApiError(data?.error || `Не удалось загрузить картинку (${response.status})`, { status: response.status, code: data?.code });
  return data;
}

export const api = {
  uploadImage,
  getConfig: () => request('/api/config', { auth: false }),
  listQuizzes: async () => (await request('/api/quizzes')).quizzes,
  getQuiz: async (id) => (await request(`/api/quizzes/${encodeURIComponent(id)}`)).quiz,
  createQuiz: async (quiz) => (await request('/api/quizzes', { method: 'POST', body: quiz })).quiz,
  updateQuiz: async (id, quiz) => (await request(`/api/quizzes/${encodeURIComponent(id)}`, { method: 'PUT', body: quiz })).quiz,
  deleteQuiz: (id) => request(`/api/quizzes/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  /** Смена пароля по текущему паролю (остальные сессии сервер отзывает). */
  changePassword: (currentPassword, newPassword) => request('/api/auth/password', { method: 'POST', body: { currentPassword, newPassword } }),
  /** Новый резервный код — показывается один раз. */
  newBackupCode: async (currentPassword) => (await request('/api/auth/backup-code', { method: 'POST', body: { currentPassword } })).backupCode,
  /** Выйти на всех устройствах, включая это. */
  logoutAll: () => request('/api/auth/logout-all', { method: 'POST' }),

  /** Сколько старых игр (созданных до аккаунтов) осталось в этом браузере. */
  async legacyCount() {
    const token = existingDeviceToken();
    if (!token) return 0;
    return (await request('/api/legacy', { headers: { Authorization: `Bearer ${token}` } })).count;
  },
  /** Перенести старые игры этого браузера в аккаунт. */
  async claimLegacy() {
    const token = existingDeviceToken();
    if (!token) return 0;
    return (await request('/api/legacy/claim', { method: 'POST', headers: { Authorization: `Bearer ${token}` } })).claimed;
  },
};
