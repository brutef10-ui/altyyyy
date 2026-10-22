import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { Browser, startTestServer, uniqueLogin } from './helpers.js';

// Админ-консоль: доступ к странице и данным, списки, карточки, журналы.
let server;
let admin;
const ADMIN_LOGIN = 'Консоль_Админ';
const ADMIN_PASSWORD = 'Admin-Secret-42';
const quiz = { title: 'Карточная игра', questions: [{ text: 'Q?', answers: ['A', 'B'], correct: 0, timeLimit: 30, readTime: 0 }] };
const photo = () => {
  const bytes = Buffer.alloc(300, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
const as = (ip) => new Browser(server, { headers: { 'X-Forwarded-For': ip } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

before(async () => {
  const adminPasswordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('admin', { adminLogin: ADMIN_LOGIN, adminPasswordHash, trustProxyHops: 1, serveSites: true });
  admin = as('192.0.2.1');
  assert.equal((await admin.login(ADMIN_LOGIN, ADMIN_PASSWORD)).status, 200);
});

after(async () => {
  await server.close();
});

async function joinRoom(browser, code, nickname) {
  await browser.session();
  const socket = await browser.socket();
  const joined = await socket.timeout(3000).emitWithAck('player:join', { code, nickname, photo: photo() });
  assert.equal(joined.ok, true, joined.error);
  socket.disconnect();
}

async function hostRoom() {
  const host = as('192.0.2.50');
  await host.register(uniqueLogin('Host'), 'host-password-1');
  const socket = await host.socket();
  const room = await socket.timeout(3000).emitWithAck('host:create', { quiz });
  return { host, socket, code: room.code };
}

test('страница консоли: гостю — вход, пользователю — 403, файлы тоже под защитой', async () => {
  const anonymous = await fetch(`${server.url}/admin/`, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/host/login.html?next=%2Fadmin%2F');
  assert.equal((await fetch(`${server.url}/admin/js/admin.js`)).status, 401);
  assert.equal((await fetch(`${server.url}/admin/css/admin.css`)).status, 401);

  const user = as('198.51.100.2');
  await user.register(uniqueLogin('Curious'), 'curious-password-1');
  assert.equal((await user.fetch('/admin/')).status, 403);
  assert.equal((await user.fetch('/admin/js/admin.js')).status, 403);
  for (const path of ['/api/admin/overview', '/api/admin/accounts', '/api/admin/visitors', '/api/admin/events', '/api/admin/audit']) {
    assert.equal((await user.fetch(path)).status, 403, path);
  }

  const page = await admin.fetch('/admin/');
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Администрирование/);
  assert.equal(page.headers.get('cache-control'), 'no-store');
  assert.equal((await admin.fetch('/admin/js/admin.js')).status, 200);
});

test('после входа администратора сервер ведёт сразу в админ-консоль, обычного пользователя — нет', async () => {
  const fresh = as('192.0.2.7');
  const adminLogin = await fresh.login(ADMIN_LOGIN, ADMIN_PASSWORD);
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.home, '/admin/');
  assert.equal((await fresh.session()).home, '/admin/');

  const user = as('198.51.100.9');
  const login = uniqueLogin('Plain');
  await user.register(login, 'plain-password-1');
  assert.equal((await user.session()).home, null);
  const other = as('198.51.100.10');
  const userLogin = await other.login(login, 'plain-password-1');
  assert.equal(userLogin.status, 200);
  assert.equal(userLogin.data.home, null);
  assert.equal((await as('198.51.100.11').session()).home, null);
});

test('гость в «Незарегистрированных»; после регистрации — в «Зарегистрированных» со своей историей', async () => {
  const { socket, code } = await hostRoom();
  const guest = as('203.0.113.10');
  await joinRoom(guest, code, 'Лиса');
  await settle();

  const guests = await admin.json('/api/admin/visitors?q=Лиса');
  assert.equal(guests.status, 200);
  assert.equal(guests.data.items.length, 1);
  const [row] = guests.data.items;
  assert.deepEqual(row.nicknames, ['Лиса']);
  assert.equal(row.lastIp, '203.0.113.10');
  assert.equal(row.joins, 1);
  assert.equal(row.shortId, row.id.slice(0, 8));

  // Тот же браузер регистрируется — и пропадает из гостей.
  const login = uniqueLogin('Fox');
  await guest.register(login, 'fox-password-1');
  assert.equal((await admin.json('/api/admin/visitors?q=Лиса')).data.items.length, 0);
  const accounts = await admin.json(`/api/admin/accounts?q=${encodeURIComponent(login.toLowerCase())}`);
  assert.equal(accounts.data.items.length, 1);
  const account = accounts.data.items[0];
  assert.equal(account.lastIp, '203.0.113.10');

  const card = await admin.json(`/api/admin/accounts/${account.id}`);
  assert.equal(card.status, 200);
  assert.equal(card.data.visitors.length, 1);
  assert.equal(card.data.visitors[0].id, row.id);
  assert.equal(card.data.beforeRegistration.events, 1, 'вход в комнату гостем — «до регистрации»');
  assert.deepEqual(card.data.nicknames.map((item) => item.nickname), ['Лиса']);
  const events = await admin.json(`/api/admin/events?accountId=${account.id}`);
  const types = events.data.items.map((event) => [event.type, event.accountId ? 'account' : 'guest']);
  assert.deepEqual(types, [['account_register', 'account'], ['room_join', 'guest']]);

  // Просмотр карточки — в журнале аудита.
  const audit = await admin.json('/api/admin/audit');
  assert.ok(audit.data.items.some((entry) => entry.action === 'account.view' && entry.targetId === account.id));
  socket.disconnect();
});

test('подсчёты IP и устройств (всего / 24ч / 7д), игры в карточке, поиск по IP и нику', async () => {
  const login = uniqueLogin('Many');
  const laptop = as('198.51.100.20');
  await laptop.register(login, 'many-password-1');
  await laptop.json('/api/quizzes', { method: 'POST', body: quiz });
  const phone = as('198.51.100.21');
  await phone.login(login, 'many-password-1');
  const tablet = as('198.51.100.21');
  await tablet.login(login, 'many-password-1');
  // Давнее событие с третьего IP — в «всего», но не в «7 дней».
  const { account } = laptop;
  await server.db.query(
    "INSERT INTO events (type, account_id, account_login, ip, created_at) VALUES ('account_login', $1, $2, '198.51.100.99', now() - interval '30 days')",
    [account.id, login],
  );

  const { data } = await admin.json(`/api/admin/accounts?q=${encodeURIComponent(login)}`);
  const [row] = data.items;
  assert.deepEqual(row.ips, { all: 3, day: 2, week: 2 });
  assert.deepEqual(row.devices, { all: 3, day: 3, week: 3 });

  assert.ok((await admin.json('/api/admin/accounts?q=198.51.100.9')).data.items.some((item) => item.id === account.id), 'поиск по началу IP');
  const card = await admin.json(`/api/admin/accounts/${account.id}`);
  assert.deepEqual(card.data.games.map((game) => game.title), ['Карточная игра']);
  assert.equal(card.data.ips.length, 3);
  assert.equal(card.data.account.activeSessions, 3);
});

test('постраничный вывод и сортировка', async () => {
  for (let i = 0; i < 3; i += 1) await as(`198.51.100.${40 + i}`).register(uniqueLogin('Page'), 'page-password-1');
  const first = await admin.json('/api/admin/accounts?limit=2&sort=created');
  assert.equal(first.data.items.length, 2);
  assert.equal(first.data.hasMore, true);
  const second = await admin.json('/api/admin/accounts?limit=2&offset=2&sort=created');
  assert.ok(second.data.items.length >= 1);
  assert.ok(new Date(first.data.items[0].createdAt) >= new Date(first.data.items[1].createdAt));
  assert.ok(!second.data.items.some((item) => first.data.items.some((other) => other.id === item.id)));

  const events = await admin.json('/api/admin/events?limit=3');
  assert.equal(events.data.items.length, 3);
  const next = await admin.json(`/api/admin/events?limit=3&before=${events.data.nextBefore}`);
  assert.ok(next.data.items.every((item) => item.id < events.data.items[2].id + 1));
  assert.equal((await admin.json('/api/admin/accounts/not-a-uuid')).status, 404);
  assert.equal((await admin.json('/api/admin/visitors/00000000-0000-4000-8000-000000000000')).status, 404);
});

test('сводка: числа считаются на сервере', async () => {
  const { data } = await admin.json('/api/admin/overview');
  const accounts = await server.db.one("SELECT count(*)::int AS n FROM accounts WHERE role = 'user'");
  assert.equal(data.accounts, accounts.n);
  assert.equal(typeof data.guests, 'number');
  assert.equal(typeof data.joins_24h, 'number');
});
