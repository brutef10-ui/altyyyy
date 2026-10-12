// REST API сервера: сохранённые игры ведущего.
import { SERVER_URL } from './config.js';

const TOKEN_KEY = 'iskra.host.token';
const TOKEN_PATTERN = /^[a-f0-9]{64}$/;

// Секретный токен браузера ведущего. Заменяет аккаунт: по нему сервер понимает, чьи это игры.
// Когда появится вход по логину, достаточно будет отправлять вместо него токен сессии.
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

async function request(path, { method = 'GET', body, auth = true } = {}) {
  const headers = {};
  if (auth) headers.Authorization = `Bearer ${getHostToken()}`;
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method,
      headers,
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  } catch {
    throw new ApiError(`Сервер недоступен (${SERVER_URL}). Проверьте, что он запущен.`);
  }

  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    throw new ApiError(data?.error || `Ошибка сервера (${response.status})`, {
      status: response.status,
      code: data?.code,
      details: data?.details,
    });
  }
  return data;
}

export const api = {
  getConfig: () => request('/api/config', { auth: false }),
  listQuizzes: async () => (await request('/api/quizzes')).quizzes,
  getQuiz: async (id) => (await request(`/api/quizzes/${encodeURIComponent(id)}`)).quiz,
  createQuiz: async (quiz) => (await request('/api/quizzes', { method: 'POST', body: quiz })).quiz,
  updateQuiz: async (id, quiz) => (await request(`/api/quizzes/${encodeURIComponent(id)}`, { method: 'PUT', body: quiz })).quiz,
  deleteQuiz: (id) => request(`/api/quizzes/${encodeURIComponent(id)}`, { method: 'DELETE' }),
};
