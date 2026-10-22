import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { Browser, startTestServer } from './helpers.js';

// Админ-консоль — только с доверенных устройств (не больше ADMIN_MAX_DEVICES, по умолчанию 2).
let server;
const LOGIN = 'Хранитель_Ключей';
const PASSWORD = 'Device-Guard-2026';
let ip = 0;
const device = () => new Browser(server, { headers: { 'X-Forwarded-For': `198.51.100.${++ip}` } });
const auditActions = async () => (await server.db.many('SELECT action FROM admin_audit ORDER BY id')).map((row) => row.action);

before(async () => {
  const adminPasswordHash = await argon2.hash(PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('devices', { adminLogin: LOGIN, adminPasswordHash, trustProxyHops: 1 });
});

after(async () => {
  await server.close();
});

test('два устройства входят, третье — нет даже с верным паролем; ответ как при неверном пароле', async () => {
  const tablet = device();
  const phone = device();
  const stranger = device();
  assert.equal((await tablet.login(LOGIN, PASSWORD)).status, 200);
  assert.equal((await phone.login(LOGIN, PASSWORD)).status, 200);
  assert.equal((await tablet.json('/api/admin/overview')).status, 200);
  assert.equal((await phone.json('/api/admin/overview')).status, 200);

  const denied = await stranger.login(LOGIN, PASSWORD);
  const wrong = await device().login(LOGIN, 'не-тот-пароль-1');
  assert.equal(denied.status, 401);
  assert.deepEqual(denied.data, wrong.data, 'не подсказываем, что пароль подошёл');
  assert.equal((await stranger.json('/api/admin/overview')).status, 401);
  assert.equal((await stranger.fetch('/admin/')).status, 302);

  // Повторный вход с доверенного устройства — как обычно.
  assert.equal((await tablet.login(LOGIN, PASSWORD)).status, 200);
  const actions = await auditActions();
  assert.equal(actions.filter((a) => a === 'admin.device.added').length, 2);
  assert.ok(actions.includes('admin.device.denied'));

  const { data } = await tablet.json('/api/admin/devices');
  assert.equal(data.max, 2);
  assert.equal(data.devices.length, 2);
  assert.equal(data.devices.filter((d) => d.current).length, 1);
});

test('cookie сессии, скопированная на другое устройство, консоль не открывает', async () => {
  const owner = device();
  await owner.session();
  // Доверенные места уже заняты — сначала освободим одно с первого устройства из предыдущего теста.
  const [first] = (await server.db.many('SELECT visitor_id FROM admin_devices ORDER BY added_at')).map((r) => r.visitor_id);
  await server.db.query('DELETE FROM admin_devices WHERE visitor_id = $1', [first]);
  await server.identity.adminDevices.load();
  assert.equal((await owner.login(LOGIN, PASSWORD)).status, 200);

  const thief = device();
  await thief.session();
  const sid = server.identity.names.session;
  thief.cookies.set(sid, owner.cookies.get(sid));
  assert.equal((await thief.json('/api/admin/overview')).status, 403);
  assert.equal((await thief.fetch('/admin/')).status, 403);
  assert.equal((await owner.json('/api/admin/overview')).status, 200);
});

test('убранное устройство сразу теряет доступ, его место занимает следующий вход', async () => {
  const keeper = device();
  // Освобождаем место для keeper и заполняем список заново: keeper + ещё одно.
  await server.db.query('DELETE FROM admin_devices');
  await server.identity.adminDevices.load();
  const other = device();
  assert.equal((await keeper.login(LOGIN, PASSWORD)).status, 200);
  assert.equal((await other.login(LOGIN, PASSWORD)).status, 200);

  const { data } = await keeper.json('/api/admin/devices');
  const target = data.devices.find((d) => !d.current);
  const removed = await keeper.fetch(`/api/admin/devices/${target.id}`, { method: 'DELETE' });
  assert.equal(removed.status, 204);
  assert.equal((await other.json('/api/admin/overview')).status, 401, 'сессия на убранном устройстве завершена');
  assert.ok((await auditActions()).includes('admin.device.removed'));

  const newcomer = device();
  assert.equal((await newcomer.login(LOGIN, PASSWORD)).status, 200, 'свободное место занял следующий вход');
  assert.equal((await device().login(LOGIN, PASSWORD)).status, 401, 'а дальше снова нельзя');
  // Обычные пользователи этим ограничением не затронуты.
  const user = device();
  await user.register(undefined, 'ordinary-password-1');
  assert.equal((await device().login(user.account.login, 'ordinary-password-1')).status, 200);
});

test('обновление сервера: уже вошедшие устройства становятся доверенными; ADMIN_DEVICE_RESET срабатывает один раз', async () => {
  const devices = server.identity.adminDevices;
  // Как до появления списка: таблица пустая, отметки о первом запуске нет, а сессии администратора есть.
  await server.db.query('DELETE FROM admin_devices');
  await server.db.query("DELETE FROM settings WHERE key = 'admin_devices'");
  await devices.load();
  const sessionsBefore = await server.db.many("SELECT DISTINCT s.visitor_id FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.role = 'admin' AND s.revoked_at IS NULL AND s.visitor_id IS NOT NULL");
  assert.ok(sessionsBefore.length >= 2);
  const boot = await devices.init({ sessions: server.identity.sessions });
  assert.equal(boot.bootstrapped, 2, 'не больше двух самых недавних');
  assert.equal((await devices.init({ sessions: server.identity.sessions })).bootstrapped, 0, 'только при первом запуске');

  const reset = await devices.init({ resetToken: 'потерял-телефон', sessions: server.identity.sessions });
  assert.equal(reset.reset, true);
  assert.equal((await server.db.one('SELECT count(*)::int AS n FROM admin_devices')).n, 0);
  const active = await server.db.one("SELECT count(*)::int AS n FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.role = 'admin' AND s.revoked_at IS NULL");
  assert.equal(active.n, 0, 'сессии администратора завершены');
  assert.equal((await devices.init({ resetToken: 'потерял-телефон', sessions: server.identity.sessions })).reset, false, 'то же значение второй раз не сбрасывает');

  const fresh = device();
  assert.equal((await fresh.login(LOGIN, PASSWORD)).status, 200, 'после сброса место занимает первый вход');
});
