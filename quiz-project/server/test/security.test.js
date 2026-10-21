import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import argon2 from 'argon2';
import { Browser, startTestServer, uniqueLogin } from './helpers.js';

// Сквозные проверки безопасности: заголовки, инъекции, лимиты, права на каждом маршруте администратора.
let server;
let admin;
let user;

before(async () => {
  const adminPasswordHash = await argon2.hash('Admin-Secret-42', { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('security', { adminLogin: 'Безопасный_Админ', adminPasswordHash, serveSites: true });
  admin = new Browser(server);
  assert.equal((await admin.login('Безопасный_Админ', 'Admin-Secret-42')).status, 200);
  user = new Browser(server);
  await user.register(uniqueLogin('Plain'), 'plain-password-1');
});

after(async () => {
  await server.close();
});

test('заголовки: строгая CSP, запрет фреймов, nosniff, без X-Powered-By', async () => {
  for (const pathname of ['/', '/host/login.html', '/api/auth/session', '/health']) {
    const response = await fetch(server.url + pathname);
    const csp = response.headers.get('content-security-policy');
    assert.match(csp, /script-src 'self'(;|$)/, pathname);
    assert.match(csp, /frame-ancestors 'none'/);
    assert.match(csp, /object-src 'none'/);
    assert.ok(!/unsafe-inline|unsafe-eval/.test(csp), 'без unsafe-inline и unsafe-eval');
    assert.equal(response.headers.get('x-frame-options'), 'DENY');
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
  }
});

test('каждый маршрут /api/admin закрыт для гостя (401) и обычного пользователя (403)', async () => {
  const source = await readFile(path.join(import.meta.dirname, '..', 'src', 'admin', 'routes.js'), 'utf8');
  const routes = [...source.matchAll(/router\.(get|post|put|delete)\('([^']+)'/g)].map(([, method, route]) => ({
    method: method.toUpperCase(),
    path: `/api/admin${route.replace(/:id/g, '00000000-0000-4000-8000-000000000000')}`,
  }));
  assert.ok(routes.length >= 15, `найдено маршрутов: ${routes.length}`);
  const anonymous = new Browser(server);
  await anonymous.session();
  for (const route of routes) {
    const body = route.method === 'GET' ? undefined : {};
    assert.equal((await anonymous.fetch(route.path, { method: route.method, body })).status, 401, `гость ${route.method} ${route.path}`);
    assert.equal((await user.fetch(route.path, { method: route.method, body })).status, 403, `пользователь ${route.method} ${route.path}`);
  }
});

test('SQL-инъекции в логине, поиске и восстановлении — обычный отказ, данные целы', async () => {
  const before = await server.db.one('SELECT count(*)::int AS n FROM accounts');
  const attempts = ["' OR '1'='1", "admin'--", "'; DROP TABLE accounts; --", '%_%', '\\'];
  for (const value of attempts) {
    const login = await new Browser(server).login(value, value);
    assert.ok([401, 429].includes(login.status), `вход: ${value} → ${login.status}`);
    const search = await admin.json(`/api/admin/accounts?q=${encodeURIComponent(value)}`);
    assert.equal(search.status, 200, `поиск: ${value}`);
    assert.equal(search.data.items.length, 0, `поиск ничего не находит по ${value}`);
    const visitors = await admin.json(`/api/admin/visitors?q=${encodeURIComponent(value)}`);
    assert.equal(visitors.status, 200);
  }
  const recoverer = new Browser(server);
  await recoverer.session();
  const recover = await recoverer.json('/api/auth/recover', { method: 'POST', body: { login: "' OR 1=1 --", code: "' OR 1=1 --", newPassword: 'valid-password-1' } });
  assert.ok([401, 429].includes(recover.status), `восстановление: ${recover.status} ${JSON.stringify(recover.data)}`);
  assert.equal((await server.db.one('SELECT count(*)::int AS n FROM accounts')).n, before.n);
});

test('лимиты размера запросов', async () => {
  const fresh = new Browser(server);
  await fresh.session();
  const big = await fresh.fetch('/api/auth/login', { method: 'POST', body: { login: 'x'.repeat(10_000), password: 'y' } });
  assert.equal(big.status, 413);
  const quiz = await user.fetch('/api/quizzes', { method: 'POST', body: { title: 'x', questions: [], pad: 'z'.repeat(300_000) } });
  assert.equal(quiz.status, 413);
  const ban = await admin.fetch('/api/admin/bans', { method: 'POST', body: { reason: 'r'.repeat(20_000) } });
  assert.equal(ban.status, 413);
});

test('неизвестный логин проверяется так же долго, как неверный пароль', async () => {
  const login = uniqueLogin('Timing');
  await new Browser(server).register(login, 'timing-password-1');
  const time = async (name) => {
    const browser = new Browser(server, { headers: { 'X-Forwarded-For': `198.51.100.${Math.floor(Math.random() * 200) + 1}` } });
    await browser.session();
    const started = process.hrtime.bigint();
    await browser.login(name, 'wrong-password-123');
    return Number(process.hrtime.bigint() - started) / 1e6;
  };
  const unknown = [];
  const wrong = [];
  for (let i = 0; i < 3; i += 1) {
    unknown.push(await time(`ghost-${i}-${login}`));
    wrong.push(await time(login));
  }
  const median = (list) => list.sort((a, b) => a - b)[1];
  assert.ok(median(unknown) > median(wrong) * 0.5, `неизвестный ${median(unknown).toFixed(1)} мс против ${median(wrong).toFixed(1)} мс`);
});

test('на HTTPS cookie с префиксом __Host-, Secure, без Domain', async () => {
  const secure = await startTestServer('securecookie', { cookieSecure: true });
  try {
    const response = await fetch(`${secure.url}/api/auth/session`);
    const cookie = response.headers.getSetCookie().find((line) => line.startsWith('__Host-vid='));
    assert.ok(cookie, 'cookie посетителя с префиксом __Host-');
    assert.match(cookie, /; Secure/);
    assert.match(cookie, /; Path=\//);
    assert.match(cookie, /; HttpOnly/);
    assert.ok(!/Domain=/i.test(cookie));
  } finally {
    await secure.close();
  }
});

test('квота картинок на аккаунт по объёму', async () => {
  const small = await startTestServer('quota', { imageQuotaMb: 1 });
  try {
    const owner = new Browser(small);
    await owner.register(uniqueLogin('Quota'), 'quota-password-1');
    const jpeg = (size) => {
      const bytes = Buffer.alloc(size, 1);
      bytes.set([0xff, 0xd8, 0xff, 0xe0]);
      return bytes;
    };
    const upload = (size) => owner.fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpeg(size), raw: true });
    assert.equal((await upload(600 * 1024)).status, 201);
    const second = await upload(600 * 1024);
    assert.equal(second.status, 409, 'вторая картинка не помещается в 1 МБ');
    assert.equal((await second.json()).code, 'TOO_MANY_IMAGES');
    assert.equal((await upload(300 * 1024)).status, 201, 'маленькая помещается');
  } finally {
    await small.close();
  }
});

test('ответы API не раскрывают хэши, токены и внутренние поля', async () => {
  const card = await admin.json(`/api/admin/accounts/${user.account.id}`);
  const text = JSON.stringify(card.data);
  assert.ok(!/password_hash|\$argon2|backup_code_hash|token_hash|code_hash/i.test(text));
  const session = JSON.stringify((await user.json('/api/auth/session')).data);
  assert.ok(!/password|hash/i.test(session));
});
