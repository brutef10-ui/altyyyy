// Общее для тестов: сервер на отдельной схеме PostgreSQL и «браузер» с cookie.
//
// Тестам нужна база: TEST_DATABASE_URL (или DATABASE_URL), например
//   TEST_DATABASE_URL=postgresql://postgres@127.0.0.1:5432/alstudio_test npm test
// Каждый файл тестов работает в своей схеме, которая удаляется после тестов.
import { randomBytes } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { startServer } from '../server.js';

export const TEST_DATABASE_URL = process.env.TEST_DATABASE_URL || process.env.DATABASE_URL || '';

export async function startTestServer(name, overrides = {}) {
  if (!TEST_DATABASE_URL) {
    throw new Error('Для тестов нужна база PostgreSQL: задайте TEST_DATABASE_URL (см. README, раздел «Тесты»).');
  }
  const schema = `t_${name}_${randomBytes(4).toString('hex')}`;
  const server = await startServer({
    port: 0,
    databaseUrl: TEST_DATABASE_URL,
    databaseSchema: schema,
    databaseSsl: 'disable',
    dbConnectAttempts: 1,
    quiet: true,
    registrationsPerIpPerHour: 1_000,
    registrationsPerHour: 10_000,
    dataFile: `/nonexistent-${schema}/quizzes.json`,
    ...overrides,
  });
  const close = server.close.bind(server);
  server.close = async () => {
    await server.db.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`).catch(() => {});
    await close();
  };
  return server;
}

let counter = 0;
export const uniqueLogin = (prefix = 'user') => `${prefix}${++counter}x${randomBytes(3).toString('hex')}`;

/** Браузер: хранит cookie, получает CSRF-токен, ходит в API и подключается к Socket.IO. */
export class Browser {
  constructor(server, { origin = 'http://localhost:5500' } = {}) {
    this.server = server;
    this.origin = origin;
    this.cookies = new Map();
    this.csrfToken = null;
    this.account = null;
  }

  cookie() {
    return [...this.cookies].map(([key, value]) => `${key}=${value}`).join('; ');
  }

  async fetch(pathname, { method = 'GET', body, headers = {}, raw = false, csrf = true } = {}) {
    const all = { Origin: this.origin, ...headers };
    const cookie = this.cookie();
    if (cookie) all.Cookie = cookie;
    if (body !== undefined && !raw) all['Content-Type'] = 'application/json';
    if (csrf && method !== 'GET' && this.csrfToken) all['X-CSRF-Token'] = this.csrfToken;
    const response = await fetch(this.server.url + pathname, {
      method,
      headers: all,
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
      redirect: 'manual',
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair, ...attributes] = line.split(';');
      const index = pair.indexOf('=');
      const key = pair.slice(0, index).trim();
      const value = pair.slice(index + 1).trim();
      const expired = attributes.some((attribute) => /^\s*max-age=0\s*$/i.test(attribute) || /expires=Thu, 01 Jan 1970/i.test(attribute));
      if (!value || expired) this.cookies.delete(key);
      else this.cookies.set(key, value);
    }
    return response;
  }

  async json(pathname, options) {
    const response = await this.fetch(pathname, options);
    const data = response.status === 204 ? null : await response.json().catch(() => null);
    return { status: response.status, data, response };
  }

  async session() {
    const { data } = await this.json('/api/auth/session');
    this.csrfToken = data.csrfToken;
    this.account = data.account;
    return data;
  }

  async register(login = uniqueLogin(), password = 'correct-horse-9') {
    if (!this.csrfToken) await this.session();
    const result = await this.json('/api/auth/register', { method: 'POST', body: { login, password } });
    if (result.status !== 201) throw new Error(`регистрация ${login}: ${result.status} ${JSON.stringify(result.data)}`);
    this.account = result.data.account;
    this.password = password;
    return result.data;
  }

  async login(login, password) {
    if (!this.csrfToken) await this.session();
    const result = await this.json('/api/auth/login', { method: 'POST', body: { login, password } });
    if (result.status === 200) this.account = result.data.account;
    return result;
  }

  /** Подключение Socket.IO с cookie этого браузера. */
  socket({ auth } = {}) {
    return new Promise((resolve, reject) => {
      const extraHeaders = { Origin: this.origin };
      const cookie = this.cookie();
      if (cookie) extraHeaders.Cookie = cookie;
      const socket = connect(this.server.url, { auth, extraHeaders, transports: ['websocket'], forceNew: true, reconnection: false });
      socket.once('connect', () => resolve(socket));
      socket.once('connect_error', reject);
    });
  }
}

/** Вошедший ведущий: браузер с новым аккаунтом. */
export async function hostBrowser(server, options) {
  const browser = new Browser(server, options);
  await browser.register(uniqueLogin('host'));
  return browser;
}
