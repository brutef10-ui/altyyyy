import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { Browser, hostBrowser, startTestServer, uniqueLogin, waitFor } from './helpers.js';
import { Retention } from '../src/logs/retention.js';

// Журнал заходов, блокировки и сроки хранения. Сервер считает IP по X-Forwarded-For (1 доверенный прокси),
// поэтому каждый «браузер» в тестах может прийти со своего адреса.
let server;
let admin;
const ADMIN_LOGIN = 'Админ_Тестов';
const ADMIN_PASSWORD = 'Admin-Secret-42';
const ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/129.0.0.0 Mobile Safari/537.36';
const quiz = { title: 'Журнал', questions: [{ text: 'Q?', answers: ['A', 'B'], correct: 0, timeLimit: 30, readTime: 0 }] };
const photo = () => {
  const bytes = Buffer.alloc(300, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
let ipCounter = 10;
const nextIp = () => `198.51.100.${ipCounter++}`;
const as = (ip, headers = {}) => new Browser(server, { headers: { 'X-Forwarded-For': ip, ...headers } });

before(async () => {
  const adminPasswordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('bans', { adminLogin: ADMIN_LOGIN, adminPasswordHash, adminContact: 'help@example.com', trustProxyHops: 1, hostSessionRecheckMs: 0 });
  admin = as('192.0.2.1');
  assert.equal((await admin.login(ADMIN_LOGIN, ADMIN_PASSWORD)).status, 200);
});

after(async () => {
  await server.close();
});

const ban = (body) => admin.json('/api/admin/bans', { method: 'POST', body });
const lift = (id, reason = 'проверка') => admin.json(`/api/admin/bans/${id}/lift`, { method: 'POST', body: { reason } });
const settle = () => new Promise((resolve) => setTimeout(resolve, 150));

async function playerIn(browser, code, nickname) {
  await browser.session();
  const socket = await browser.socket();
  const joined = await socket.timeout(3000).emitWithAck('player:join', { code, nickname, photo: photo() });
  assert.equal(joined.ok, true, joined.error);
  return { socket, joined };
}

test('журнал: регистрация, вход, игра, комната и вход по коду с IP, устройством и браузером', async () => {
  const ip = nextIp();
  const host = as(ip, { 'User-Agent': ANDROID });
  const login = uniqueLogin('Log');
  await host.register(login, 'log-password-1');
  await host.json('/api/auth/logout', { method: 'POST' });
  await host.login(login, 'log-password-1');
  const { data } = await host.json('/api/quizzes', { method: 'POST', body: quiz });
  const socket = await host.socket();
  const created = await socket.timeout(3000).emitWithAck('host:create', { quizId: data.quiz.id });

  const guestIp = nextIp();
  const guest = as(guestIp);
  const { socket: player } = await playerIn(guest, created.code, 'Гостья');
  await settle();

  const rows = await server.db.many(
    `SELECT type, visitor_id, account_login, nickname, room_code, host(ip) AS ip, device_type, os, browser, details
       FROM events WHERE account_login = $1 OR room_code = $2 ORDER BY id`,
    [login, created.code],
  );
  assert.deepEqual(rows.map((row) => row.type), ['account_register', 'account_login', 'quiz_create', 'room_create', 'room_join']);
  const [register, , quizCreated, roomCreated, join] = rows;
  assert.equal(register.ip, ip);
  assert.equal(register.device_type, 'mobile');
  assert.equal(register.os, 'Android 14');
  assert.equal(register.browser, 'Chrome 129');
  assert.ok(register.visitor_id, 'посетитель записан');
  assert.equal(quizCreated.details.title, 'Журнал');
  assert.equal(roomCreated.room_code, created.code);
  assert.equal(join.nickname, 'Гостья');
  assert.equal(join.ip, guestIp);
  assert.equal(join.account_login, null, 'гость без аккаунта');
  assert.ok(join.visitor_id);
  const noSecrets = await server.db.one("SELECT count(*)::int AS n FROM events WHERE details::text ILIKE '%password%'");
  assert.equal(noSecrets.n, 0);

  socket.disconnect();
  player.disconnect();
});

test('блокировка аккаунта: API, вход и Socket.IO закрыты, причина и срок видны', async () => {
  const ip = nextIp();
  const user = as(ip);
  const login = uniqueLogin('Bad');
  const { account } = await user.register(login, 'bad-password-1');

  const created = await ban({ accountId: account.id, reason: 'Спам в названиях игр', durationMinutes: 60 });
  assert.equal(created.status, 201, JSON.stringify(created.data));
  assert.equal(created.data.ban.status, 'active');

  const blocked = await user.json('/api/quizzes');
  assert.equal(blocked.status, 403);
  assert.equal(blocked.data.code, 'BANNED');
  assert.equal(blocked.data.details.reason, 'Спам в названиях игр');
  assert.equal(blocked.data.details.forever, false);
  assert.equal(blocked.data.details.contact, 'help@example.com');
  assert.equal((await user.session()).ban.reason, 'Спам в названиях игр');

  // С другого устройства и IP: пароль верный, но вход закрыт.
  const elsewhere = as(nextIp());
  const loginAttempt = await elsewhere.login(login, 'bad-password-1');
  assert.equal(loginAttempt.status, 403);
  assert.equal(loginAttempt.data.code, 'BANNED');
  assert.equal((await elsewhere.session()).account, null, 'сессия не создана');

  // Socket.IO: подключение отклоняется с причиной.
  await assert.rejects(user.socket(), (error) => error.data?.code === 'BANNED' && error.data.ban.reason === 'Спам в названиях игр');

  assert.equal((await lift(created.data.ban.id)).data.ban.status, 'lifted');
  assert.equal((await user.json('/api/quizzes')).status, 200, 'после снятия доступ вернулся');
});

test('блокировка устройства гостя действует и после регистрации; IP — по адресу и подсети', async () => {
  const ip = nextIp();
  const guest = as(ip);
  await guest.session();
  // Узнаём visitor_id гостя через вход в комнату.
  const host = await hostBrowser(server);
  const hostSocket = await host.socket();
  const room = await hostSocket.timeout(3000).emitWithAck('host:create', { quiz });
  const { socket } = await playerIn(guest, room.code, 'Хулиган');
  await settle();
  const { visitor_id: guestVisitor } = await server.db.one("SELECT visitor_id FROM events WHERE type = 'room_join' AND nickname = 'Хулиган'");
  socket.disconnect();

  const visitorBan = await ban({ visitorId: guestVisitor, reason: 'Оскорбления в нике', forever: true });
  assert.equal(visitorBan.status, 201);
  const register = await guest.json('/api/auth/register', { method: 'POST', body: { login: uniqueLogin('Again'), password: 'again-password-1' } });
  assert.equal(register.data.code, 'BANNED', 'заблокированный гость не может зарегистрироваться');
  assert.equal(register.data.details.forever, true);
  assert.equal((await guest.json(`/api/rooms/${room.code}`)).data.code, 'BANNED', 'и войти в комнату по коду');
  await assert.rejects(guest.socket(), (error) => error.data?.code === 'BANNED');
  await lift(visitorBan.data.ban.id);

  // IP: адрес и подсеть /24; слишком широкая подсеть — отказ.
  assert.equal((await ban({ ip: '203.0.0.0/16', reason: 'Слишком широко', forever: true })).status, 422);
  const subnetBan = await ban({ ip: '203.0.113.0/24', reason: 'Атака с подсети', durationMinutes: 30 });
  assert.equal(subnetBan.status, 201);
  assert.equal((await as('203.0.113.200').json(`/api/rooms/${room.code}`)).data.code, 'BANNED');
  assert.equal((await as('203.0.114.1').json(`/api/rooms/${room.code}`)).status, 200, 'соседняя подсеть не затронута');
  await lift(subnetBan.data.ban.id);
  assert.equal((await as('203.0.113.200').json(`/api/rooms/${room.code}`)).status, 200);

  await hostSocket.timeout(3000).emitWithAck('host:close', {});
  hostSocket.disconnect();
});

test('несколько блокировок: действует самая долгая; истёкшие не действуют; история сохраняется', async () => {
  const user = as(nextIp());
  const { account } = await user.register(uniqueLogin('Multi'), 'multi-password-1');
  const short = await ban({ accountId: account.id, reason: 'Короткая', durationMinutes: 5 });
  const forever = await ban({ accountId: account.id, reason: 'Навсегда', forever: true });
  assert.equal((await user.session()).ban.reason, 'Навсегда');
  await lift(forever.data.ban.id);
  assert.equal((await user.session()).ban.reason, 'Короткая', 'снятие одной не снимает другую');

  // Срок короткой вышел.
  await server.db.query("UPDATE bans SET starts_at = now() - interval '10 minutes', ends_at = now() - interval '1 second' WHERE id = $1", [short.data.ban.id]);
  await server.identity.bans.load();
  assert.equal((await user.session()).ban, null, 'истёкшая блокировка не действует');

  const history = await admin.json('/api/admin/bans?status=all&limit=100');
  const mine = history.data.bans.filter((item) => item.accountId === account.id);
  assert.deepEqual(mine.map((item) => item.status).sort(), ['expired', 'lifted']);
  const active = await admin.json('/api/admin/bans');
  assert.ok(!active.data.bans.some((item) => item.accountId === account.id));

  const audit = await server.db.many("SELECT action FROM admin_audit WHERE target_id = $1 ORDER BY id", [account.id]);
  assert.deepEqual(audit.map((row) => row.action), ['ban.create', 'ban.create', 'ban.lift']);
});

test('блокировка посреди игры: игрок удаляется из комнаты, комната заблокированного ведущего закрывается', async () => {
  const host = as(nextIp());
  const hostLogin = uniqueLogin('GameHost');
  const { account: hostAccount } = await host.register(hostLogin, 'host-password-1');
  const hostSocket = await host.socket();
  const room = await hostSocket.timeout(3000).emitWithAck('host:create', { quiz });

  const good = await playerIn(as(nextIp()), room.code, 'Хороший');
  const badBrowser = as(nextIp());
  const bad = await playerIn(badBrowser, room.code, 'Плохой');
  await settle();
  assert.equal(server.rooms.get(room.code).players.size, 2);

  const left = new Promise((resolve) => hostSocket.on('lobby:update', (update) => update.action === 'leave' && resolve(update)));
  const banned = waitFor(bad.socket, 'access:banned');
  const disconnected = waitFor(bad.socket, 'disconnect');
  const { visitor_id: badVisitor } = await server.db.one("SELECT visitor_id FROM events WHERE type = 'room_join' AND nickname = 'Плохой' ORDER BY id DESC LIMIT 1");
  await ban({ visitorId: badVisitor, reason: 'Мешает игре', durationMinutes: 120 });
  const notice = await banned;
  assert.equal(notice.reason, 'Мешает игре');
  assert.equal(notice.forever, false);
  await disconnected;
  assert.equal((await left).playerId, bad.joined.playerId);
  assert.equal(server.rooms.get(room.code).players.size, 1);

  // Возврат по сохранённому токену комнаты не помогает: подключение отклоняется.
  await assert.rejects(badBrowser.socket(), (error) => error.data?.code === 'BANNED');

  // Блокировка ведущего закрывает его комнату; игроки получают уведомление.
  const closed = waitFor(good.socket, 'room:closed');
  await ban({ accountId: hostAccount.id, reason: 'Нарушение правил', forever: true });
  assert.equal((await closed).reason, 'host-banned');
  assert.equal(server.rooms.get(room.code), null);
  good.socket.disconnect();
});

test('админ: блокировать администратора нельзя; не админу маршруты закрыты', async () => {
  assert.equal((await ban({ accountId: admin.account.id, reason: 'Попытка', forever: true })).status, 409);
  const user = as(nextIp());
  await user.register(uniqueLogin('Nosy'), 'nosy-password-1');
  assert.equal((await user.json('/api/admin/bans')).status, 403);
  assert.equal((await user.json('/api/admin/bans', { method: 'POST', body: { ip: '1.2.3.4', reason: 'xxx', forever: true } })).status, 403);
  assert.equal((await ban({ reason: 'Без цели', forever: true })).status, 422);
  assert.equal((await ban({ ip: '1.2.3.4', reason: 'x', forever: true })).status, 422, 'слишком короткая причина');
});

test('сроки хранения: старые события обезличиваются, аудит и история блокировок удаляются', async () => {
  const old = await server.db.one(
    `INSERT INTO events (type, ip, user_agent, device_type, os, browser, nickname, created_at)
     VALUES ('room_join', '203.0.113.77', 'UA', 'mobile', 'Android 14', 'Chrome 129', 'Старый', now() - interval '200 days') RETURNING id`,
  );
  const fresh = await server.db.one("INSERT INTO events (type, ip, user_agent) VALUES ('room_join', '203.0.113.78', 'UA') RETURNING id");
  await server.db.query("INSERT INTO admin_audit (action, created_at) VALUES ('old.action', now() - interval '4 years')");
  await server.db.query(
    "INSERT INTO bans (ip, reason, starts_at, ends_at, created_at) VALUES ('192.0.2.200', 'Давно', now() - interval '5 years', now() - interval '4 years', now() - interval '5 years')",
  );
  const result = await new Retention(server.db, server.config).run();
  assert.ok(result.anonymizedEvents >= 1 && result.deletedAudit >= 1 && result.deletedBans >= 1, JSON.stringify(result));

  const oldRow = await server.db.one('SELECT ip::text AS ip, user_agent, device_type, nickname, anonymized_at FROM events WHERE id = $1', [old.id]);
  assert.equal(oldRow.ip, '203.0.113.0/24');
  assert.equal(oldRow.user_agent, null);
  assert.equal(oldRow.device_type, 'mobile', 'тип устройства сохраняется для подсчётов');
  assert.ok(oldRow.anonymized_at);
  const freshRow = await server.db.one('SELECT host(ip) AS ip, user_agent FROM events WHERE id = $1', [fresh.id]);
  assert.deepEqual(freshRow, { ip: '203.0.113.78', user_agent: 'UA' });
  assert.equal((await server.db.one("SELECT count(*)::int AS n FROM admin_audit WHERE action = 'old.action'")).n, 0);
  assert.equal((await server.db.one("SELECT count(*)::int AS n FROM bans WHERE reason = 'Давно'")).n, 0);
});
