import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import argon2 from 'argon2';
import { Browser, hostBrowser, startTestServer, uniqueLogin } from './helpers.js';
import { clientIp } from '../src/identity/clientIp.js';

// Аккаунты, сессии, CSRF, лимиты попыток, администратор из окружения, владельцы игр.
let server;
const ADMIN_LOGIN = 'Главный_Тестовый_Админ';
const ADMIN_PASSWORD = 'Admin-Secret-42';
const quiz = { title: 'Своя игра', questions: [{ text: 'Q?', answers: ['A', 'B'], correct: 0, timeLimit: 10, readTime: 0 }] };

before(async () => {
  const adminPasswordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('auth', { adminLogin: ADMIN_LOGIN, adminPasswordHash, hostSessionRecheckMs: 0 });
});

after(async () => {
  await server.close();
});

test('регистрация: проверка логина и пароля, резервный код только хэшем', async () => {
  const browser = new Browser(server);
  await browser.session();
  const attempt = (login, password) => browser.json('/api/auth/register', { method: 'POST', body: { login, password } });

  assert.equal((await attempt('Иван', 'long-enough-1')).data.code, 'BAD_LOGIN', 'кириллица в логине');
  assert.equal((await attempt('ab', 'long-enough-1')).data.code, 'BAD_LOGIN', 'короткий логин');
  assert.equal((await attempt('valid_name', 'short')).data.code, 'BAD_PASSWORD');
  assert.equal((await attempt('valid_name', 'пароль-кириллицей')).data.code, 'BAD_PASSWORD');
  assert.equal((await attempt('admin', 'long-enough-1')).data.code, 'LOGIN_TAKEN', 'зарезервированный логин');
  assert.equal((await attempt(ADMIN_LOGIN, 'long-enough-1')).data.code, 'BAD_LOGIN', 'логин админа не зарегистрировать');

  const login = uniqueLogin('Reg');
  const created = await attempt(login, 'long-enough-1');
  assert.equal(created.status, 201);
  assert.equal(created.data.account.role, 'user');
  assert.match(created.data.backupCode, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.equal((await new Browser(server).session(), (await attempt(login.toUpperCase(), 'long-enough-1')).data.code), 'LOGIN_TAKEN', 'логин без учёта регистра');

  const row = await server.db.one('SELECT password_hash, backup_code_hash FROM accounts WHERE id = $1', [created.data.account.id]);
  assert.match(row.password_hash, /^\$argon2id\$/);
  assert.ok(!row.password_hash.includes('long-enough-1'));
  const normalized = created.data.backupCode.replace(/-/g, '');
  assert.deepEqual(row.backup_code_hash, createHash('sha256').update(normalized).digest(), 'в БД только SHA-256 кода');

  // Ловушка для ботов.
  const bot = new Browser(server);
  await bot.session();
  assert.equal((await bot.json('/api/auth/register', { method: 'POST', body: { login: uniqueLogin(), password: 'long-enough-1', website: 'http://spam' } })).data.code, 'REJECTED');
});

test('вход: одинаковая ошибка, ротация сессии, выход', async () => {
  const owner = new Browser(server);
  const { account } = await owner.register(uniqueLogin('Login'), 'long-enough-1');
  const firstSid = [...owner.cookies].find(([key]) => key.endsWith('sid'))[1];

  const other = new Browser(server);
  const unknown = await other.login('nobody-here', 'long-enough-1');
  const wrong = await other.login(account.login, 'wrong-password');
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.data, wrong.data, 'неизвестный логин и неверный пароль неразличимы');

  const ok = await owner.login(account.login.toUpperCase(), 'long-enough-1');
  assert.equal(ok.status, 200);
  const secondSid = [...owner.cookies].find(([key]) => key.endsWith('sid'))[1];
  assert.notEqual(secondSid, firstSid, 'при входе выдаётся новая сессия');
  const stale = new Browser(server);
  stale.cookies.set('sid', firstSid);
  assert.equal((await stale.session()).account, null, 'старая сессия отозвана');

  assert.equal((await owner.json('/api/auth/logout', { method: 'POST' })).status, 204);
  assert.equal((await owner.fetch('/api/quizzes')).status, 401);
  const reuse = new Browser(server);
  reuse.cookies.set('sid', secondSid);
  assert.equal((await reuse.session()).account, null, 'после выхода cookie не работает');
});

test('лимиты: подбор пароля блокируется и переживает перезапуск (хранится в БД)', async () => {
  const victim = new Browser(server);
  const { account } = await victim.register(uniqueLogin('Victim'), 'long-enough-1');
  const attacker = new Browser(server);
  const codes = [];
  for (let i = 0; i < 7; i += 1) codes.push((await attacker.login(account.login, `guess-${i}-xxxx`)).status);
  assert.deepEqual(codes.slice(0, 4), [401, 401, 401, 401]);
  assert.equal(codes[4], 429, 'пятая неудача включает блокировку');
  assert.equal(codes[5], 429);
  assert.equal((await attacker.login(account.login, 'long-enough-1')).status, 429, 'даже верный пароль ждёт окончания блокировки');
  const stored = await server.db.one("SELECT blocked_until > now() AS blocked FROM auth_throttle WHERE key LIKE 'login:acct-ip:%' AND key LIKE $1", [`%${account.login.toLowerCase()}%`]);
  assert.equal(stored.blocked, true);
});

test('CSRF: без токена или с чужого сайта изменения запрещены', async () => {
  const owner = await hostBrowser(server);
  assert.equal((await owner.fetch('/api/quizzes', { method: 'POST', body: quiz, csrf: false })).status, 403);
  assert.equal((await owner.fetch('/api/quizzes', { method: 'POST', body: quiz, headers: { Origin: 'https://evil.example' } })).status, 403);
  const foreign = new Browser(server);
  await foreign.session();
  owner.csrfToken = foreign.csrfToken;
  assert.equal((await owner.fetch('/api/quizzes', { method: 'POST', body: quiz })).status, 403, 'токен другого посетителя не подходит');
  await owner.session();
  assert.equal((await owner.fetch('/api/quizzes', { method: 'POST', body: quiz })).status, 201);
});

test('смена пароля и новый резервный код: нужен текущий пароль, другие сессии отзываются', async () => {
  const login = uniqueLogin('Change');
  const laptop = new Browser(server);
  await laptop.register(login, 'long-enough-1');
  const phone = new Browser(server);
  assert.equal((await phone.login(login, 'long-enough-1')).status, 200);

  assert.equal((await laptop.json('/api/auth/password', { method: 'POST', body: { currentPassword: 'nope-nope-nope', newPassword: 'brand-new-pass-2' } })).status, 403);
  assert.equal((await laptop.json('/api/auth/password', { method: 'POST', body: { currentPassword: 'long-enough-1', newPassword: 'brand-new-pass-2' } })).status, 200);
  assert.equal((await laptop.session()).account?.login, login, 'текущее устройство остаётся в аккаунте');
  assert.equal((await phone.session()).account, null, 'другие сессии отозваны');
  assert.equal((await phone.login(login, 'long-enough-1')).status, 401);
  assert.equal((await phone.login(login, 'brand-new-pass-2')).status, 200);

  const before = await server.db.one('SELECT backup_code_hash FROM accounts WHERE login = $1', [login]);
  assert.equal((await laptop.json('/api/auth/backup-code', { method: 'POST', body: { currentPassword: 'wrong-one-123' } })).status, 403);
  const fresh = await laptop.json('/api/auth/backup-code', { method: 'POST', body: { currentPassword: 'brand-new-pass-2' } });
  assert.equal(fresh.status, 200);
  const afterRow = await server.db.one('SELECT backup_code_hash FROM accounts WHERE login = $1', [login]);
  assert.notDeepEqual(afterRow.backup_code_hash, before.backup_code_hash, 'старый код больше не действует');
});

test('администратор: только из окружения, роль не берётся из запроса', async () => {
  const admin = new Browser(server);
  const ok = await admin.login(ADMIN_LOGIN.toLowerCase(), ADMIN_PASSWORD);
  assert.equal(ok.status, 200);
  assert.equal(ok.data.account.role, 'admin');
  assert.equal((await admin.json('/api/auth/password', { method: 'POST', body: { currentPassword: ADMIN_PASSWORD, newPassword: 'other-pass-123' } })).data.code, 'ADMIN_MANAGED');

  const sneaky = new Browser(server);
  await sneaky.session();
  const result = await sneaky.json('/api/auth/register', { method: 'POST', body: { login: uniqueLogin('Sneaky'), password: 'long-enough-1', role: 'admin' } });
  assert.equal(result.data.account.role, 'user');

  // Обычный аккаунт с логином, который потом укажут в ADMIN_LOGIN, админом не становится.
  const plain = new Browser(server);
  const { account } = await plain.register(uniqueLogin('Plain'), 'long-enough-1');
  const conflict = await server.identity.accounts.ensureAdmin({ login: account.login, passwordHash: '$argon2id$v=19$m=19456,t=2,p=1$x$y' }, server.identity.sessions);
  assert.equal(conflict.status, 'conflict');
  assert.equal((await server.db.one('SELECT role FROM accounts WHERE id = $1', [account.id])).role, 'user');
  // Смена ADMIN_LOGIN понижает прежнего администратора и закрывает его сессии.
  assert.equal(conflict.demoted, 1);
  assert.equal((await admin.session()).account, null);
  // Возвращаем как было.
  const restored = await server.identity.accounts.ensureAdmin({ login: ADMIN_LOGIN, passwordHash: server.config.adminPasswordHash }, server.identity.sessions);
  assert.equal(restored.status, 'updated', 'аккаунт из окружения снова становится администратором');
  assert.equal((await new Browser(server).login(ADMIN_LOGIN, ADMIN_PASSWORD)).data.account.role, 'admin');
});

test('игры: чужие игры недоступны ни по REST, ни через Socket.IO', async () => {
  const owner = await hostBrowser(server);
  const stranger = await hostBrowser(server);
  const { data } = await owner.json('/api/quizzes', { method: 'POST', body: quiz });
  const id = data.quiz.id;
  assert.equal((await stranger.fetch(`/api/quizzes/${id}`)).status, 404);
  assert.equal((await stranger.fetch(`/api/quizzes/${id}`, { method: 'PUT', body: quiz })).status, 404);
  assert.equal((await stranger.fetch(`/api/quizzes/${id}`, { method: 'DELETE' })).status, 404);
  assert.equal((await owner.json('/api/quizzes')).data.quizzes.length, 1);

  const socket = await stranger.socket();
  const response = await socket.timeout(3000).emitWithAck('host:create', { quizId: id });
  assert.equal(response.code, 'NOT_FOUND');
  socket.disconnect();
});

test('Socket.IO: создать комнату можно только вошедшему; отозванная сессия перестаёт работать', async () => {
  const anonymous = await new Browser(server).socket({ auth: { token: randomBytes(32).toString('hex') } });
  assert.equal((await anonymous.timeout(3000).emitWithAck('host:create', { quiz })).code, 'UNAUTHORIZED', 'токен устройства больше не даёт прав');
  anonymous.disconnect();

  const host = await hostBrowser(server);
  const socket = await host.socket();
  await host.json('/api/auth/logout', { method: 'POST' });
  assert.equal((await socket.timeout(3000).emitWithAck('host:create', { quiz })).code, 'UNAUTHORIZED', 'выход закрывает и уже открытое соединение');
  socket.disconnect();
});

test('Socket.IO: команды хода игры перепроверяют сессию ведущего', async () => {
  const host = await hostBrowser(server);
  const socket = await host.socket();
  const created = await socket.timeout(3000).emitWithAck('host:create', { quiz });
  assert.equal(created.ok, true);

  // Тот же аккаунт с другого устройства вошёл и вышел везде — команды этого сокета отклоняются.
  const phone = new Browser(server);
  await phone.login(host.account.login, 'correct-horse-9');
  await phone.json('/api/auth/logout-all', { method: 'POST' });
  for (const event of ['host:start', 'host:next', 'host:reveal', 'host:kick', 'host:close']) {
    assert.equal((await socket.timeout(3000).emitWithAck(event, {})).code, 'UNAUTHORIZED', event);
  }
  assert.ok(server.rooms.get(created.code), 'комната не закрыта чужой командой');

  // После нового входа ведущий возвращается в свою комнату по ключу и продолжает.
  await host.login(host.account.login, 'correct-horse-9');
  const again = await host.socket();
  const resumed = await again.timeout(3000).emitWithAck('host:resume', { code: created.code, hostKey: created.hostKey });
  assert.equal(resumed.ok, true, resumed.error);
  assert.equal((await again.timeout(3000).emitWithAck('host:close', {})).ok, true);
  socket.disconnect();
  again.disconnect();
});

test('перенос старых игр: только по токену того же браузера', async () => {
  const deviceToken = randomBytes(32).toString('hex');
  const deviceOwner = `device:${createHash('sha256').update(deviceToken).digest('hex')}`;
  const legacyId = '11111111-2222-4333-8444-555555555555';
  await server.db.query(
    'INSERT INTO legacy_quizzes (id, device_owner, title, data, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())',
    [legacyId, deviceOwner, 'Старая игра', { title: 'Старая игра', questions: quiz.questions }],
  );
  const thief = await hostBrowser(server);
  const otherToken = randomBytes(32).toString('hex');
  assert.equal((await thief.json('/api/legacy', { headers: { Authorization: `Bearer ${otherToken}` } })).data.count, 0);
  assert.equal((await thief.json('/api/legacy/claim', { method: 'POST', headers: { Authorization: `Bearer ${otherToken}` } })).data.claimed, 0);

  const owner = await hostBrowser(server);
  assert.equal((await owner.json('/api/legacy', { headers: { Authorization: `Bearer ${deviceToken}` } })).data.count, 1);
  assert.equal((await owner.json('/api/legacy/claim', { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}` } })).data.claimed, 1);
  assert.equal((await owner.json(`/api/quizzes/${legacyId}`)).data.quiz.title, 'Старая игра');
  assert.equal((await owner.json('/api/legacy/claim', { method: 'POST', headers: { Authorization: `Bearer ${deviceToken}` } })).data.claimed, 0, 'повторно не переносится');
  assert.equal((await new Browser(server).fetch('/api/legacy')).status, 401);
});

test('IP за прокси: подделанный первый адрес X-Forwarded-For не принимается', () => {
  const headers = { 'x-forwarded-for': '6.6.6.6, 203.0.113.7, 10.0.0.2' };
  const hops = (n) => clientIp({ remoteAddress: '10.0.0.1', headers }, { clientIpMode: 'hops', trustProxyHops: n });
  assert.equal(hops(0), '10.0.0.1');
  assert.equal(hops(1), '10.0.0.2');
  assert.equal(hops(2), '203.0.113.7');
  assert.equal(hops(9), '6.6.6.6', 'больше прокси, чем адресов — самый левый');
  assert.equal(clientIp({ remoteAddress: '::ffff:127.0.0.1', headers: {} }, { clientIpMode: 'hops', trustProxyHops: 1 }), '127.0.0.1');
  const header = { clientIpMode: 'header', clientIpHeader: 'cf-connecting-ip', trustProxyHops: 1 };
  assert.equal(clientIp({ remoteAddress: '10.0.0.1', headers: { 'cf-connecting-ip': '198.51.100.4', ...headers } }, header), '198.51.100.4');
  assert.equal(clientIp({ remoteAddress: '10.0.0.1', headers: { 'cf-connecting-ip': 'garbage', ...headers } }, header), '10.0.0.2', 'мусор в заголовке — запасной режим');
});

test('health показывает состояние БД; cookie HttpOnly и SameSite', async () => {
  const health = await (await fetch(`${server.url}/health`)).json();
  assert.equal(health.db, 'ok');
  const response = await fetch(`${server.url}/api/auth/session`);
  const cookie = response.headers.getSetCookie().find((line) => line.startsWith('vid='));
  assert.match(cookie, /HttpOnly/i);
  assert.match(cookie, /SameSite=Lax/i);
  assert.match(cookie, /Max-Age=31536000/);
});
