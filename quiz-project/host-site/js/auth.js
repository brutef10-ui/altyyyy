// Вход в аккаунт создателя игр (на стороне браузера — только интерфейс).
//
// Сессия живёт в HttpOnly-cookie, которую JavaScript не видит; права проверяет сервер на каждом запросе.
// Здесь только: узнать, кто вошёл, получить CSRF-токен для изменяющих запросов и отправить на вход.
import { SERVER_URL } from './config.js';
import { curtain } from './theatre.js';
import { hostSession } from './session.js';

let current = null; // { account, csrfToken, adminContact }
let loading = null;

/** Состояние входа с сервера: { account: { id, login, role } | null, csrfToken, adminContact }. */
export function loadSession({ force = false } = {}) {
  if (current && !force) return Promise.resolve(current);
  if (loading && !force) return loading;
  loading = fetch(`${SERVER_URL}/api/auth/session`, { credentials: 'include', cache: 'no-store' })
    .then(async (response) => {
      if (!response.ok) throw new Error(`Ошибка сервера (${response.status})`);
      current = await response.json();
      return current;
    })
    .finally(() => {
      loading = null;
    });
  return loading;
}

export const csrfToken = () => current?.csrfToken ?? null;

/** Запомнить ответ сервера после входа или регистрации. */
export function setAccount(account) {
  if (current) current.account = account;
}

// Куда вернуться после входа: только страницы этого же сайта.
export function safeNext(value, fallback = 'index.html') {
  if (!value) return fallback;
  try {
    const url = new URL(value, location.href);
    const base = new URL('./', location.href);
    // Сайт ведущего или админ-консоль на том же сервере (/admin/).
    const allowed = url.pathname.startsWith(base.pathname) || url.pathname === '/admin/' || url.pathname.startsWith('/admin/');
    if (url.origin !== location.origin || !allowed || /login\.html$/.test(url.pathname)) return fallback;
    return url.pathname + url.search + url.hash;
  } catch {
    return fallback;
  }
}

export function loginUrl(next = location.pathname + location.search) {
  return `login.html?next=${encodeURIComponent(next)}`;
}

let redirecting = false;

/** На страницу входа (сессии нет или она истекла). */
export function goToLogin(next) {
  if (redirecting) return;
  redirecting = true;
  curtain.go(loginUrl(next), { replace: true });
}

/** Страница только для вошедших: без входа — на страницу входа. Возвращает аккаунт или null. */
export async function requireAccount() {
  try {
    const { account } = await loadSession();
    if (!account) goToLogin();
    return account;
  } catch {
    return null; // сервер недоступен — страница сама покажет ошибку при первом запросе
  }
}

export async function logout() {
  try {
    await loadSession();
    await fetch(`${SERVER_URL}/api/auth/logout`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'X-CSRF-Token': csrfToken() ?? '' },
    });
  } finally {
    current = null;
    hostSession.clear();
    curtain.go('login.html', { replace: true });
  }
}
