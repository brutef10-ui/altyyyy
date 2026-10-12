// Адрес сервера игры.
//
// Для продакшена впишите сюда адрес сервера, например 'https://al-studio-server.onrender.com'.
// tools/serve.js умеет подставлять его сам из переменной окружения SERVER_URL.
const PRODUCTION_SERVER_URL = '';

function detectServerUrl() {
  if (window.QUIZ_SERVER_URL) return window.QUIZ_SERVER_URL;
  if (PRODUCTION_SERVER_URL) return PRODUCTION_SERVER_URL;
  // Локально: сервер на том же компьютере, порт 3000.
  const { protocol, hostname } = window.location;
  return `${protocol === 'https:' ? 'https:' : 'http:'}//${hostname || 'localhost'}:3000`;
}

export const SERVER_URL = detectServerUrl().replace(/\/+$/, '');
