import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { analyzeAccount, subnetOf } from '../src/admin/sharing.js';
import { SHARING_DEFAULTS } from '../src/admin/sharingConfig.js';
import { Browser, startTestServer, uniqueLogin } from './helpers.js';

// Подсказки о шаринге: каждая подсказка по отдельности и включение в консоли.
const config = SHARING_DEFAULTS;
const MIN = 60_000;
const t0 = new Date('2026-10-20T07:00:00Z').getTime();
const at = (minutes) => new Date(t0 + minutes * MIN);
const GEO = {
  '95.24.1.15': { country: 'RU', city: 'Moscow', ll: [55.75, 37.62] },
  '95.24.2.20': { country: 'RU', city: 'Moscow', ll: [55.75, 37.62] },
  '178.66.10.5': { country: 'RU', city: 'St Petersburg', ll: [59.94, 30.31] },
  '89.250.1.1': { country: 'RU', city: 'Novosibirsk', ll: [55.03, 82.92] },
};
const geoLookup = (ip) => GEO[ip] ?? null;
const run = (events, sessions = []) => analyzeAccount({ events, sessions }, config, { geoLookup, now: t0 + 60 * MIN, timeZone: 'Europe/Moscow' });
const signals = (result) => result.reasons.map((reason) => reason.signal);
const ev = (minutes, visitorId, ip, extra = {}) => ({ visitorId, ip, type: 'account_login', createdAt: at(minutes), os: 'Android 14', deviceType: 'mobile', ...extra });

test('подсеть: /24 и /48', () => {
  assert.equal(subnetOf('203.0.113.77'), '203.0.113.0/24');
  assert.equal(subnetOf('2a02:6b8:1:2::5'), '2a02:6b8:1::/48');
  assert.equal(subnetOf('garbage'), null);
});

test('одновременные сессии: разные устройства и сети — высокий вес; та же /24 — не считается; один город — ниже', () => {
  const session = (visitorId, ip, from, to, until = 24 * 60) => ({ visitorId, ip, createdAt: at(from), lastSeenAt: at(to), validUntil: at(until) });
  const far = run([], [session('a', '95.24.1.15', 0, 60), session('b', '178.66.10.5', 30, 90)]);
  assert.deepEqual(signals(far), ['concurrent']);
  assert.equal(far.reasons[0].weight, 40);
  assert.equal(far.level, 'yellow');
  const sameCity = run([], [session('a', '95.24.1.15', 0, 60), session('b', '95.24.2.20', 30, 90)]);
  assert.equal(sameCity.reasons[0].weight, 12, 'та же сеть города — ниже');
  assert.equal(sameCity.level, 'green');
  assert.deepEqual(signals(run([], [session('a', '95.24.1.15', 0, 60), session('b', '95.24.1.99', 30, 90)])), [], 'та же /24');
  assert.deepEqual(signals(run([], [session('a', '95.24.1.15', 0, 20, 25), session('b', '178.66.10.5', 30, 90)])), [], 'первая закончилась до второй');
  assert.deepEqual(signals(run([], [session('a', '95.24.1.15', 0, 0), session('b', '178.66.10.5', 300, 300)])), [], 'использовались с разницей в 5 часов');
  assert.deepEqual(signals(run([], [session('a', '95.24.1.15', 0, 0), session('b', '178.66.10.5', 2, 2)])), ['concurrent'], 'два входа подряд, обе сессии действуют');
  assert.deepEqual(signals(run([], [session('a', '95.24.1.15', 0, 60), session('a', '178.66.10.5', 30, 90)])), [], 'смена IP у того же устройства');
});

test('слишком быстрая смена города', () => {
  const jump = run([ev(0, 'a', '95.24.1.15'), ev(20, 'b', '89.250.1.1')]);
  assert.deepEqual(signals(jump), ['geoJump']);
  assert.match(jump.reasons[0].text, /Moscow.*Novosibirsk/);
  assert.deepEqual(signals(run([ev(0, 'a', '95.24.1.15'), ev(20, 'a', '95.24.2.20')])), [], 'тот же город');
  assert.deepEqual(signals(run([ev(0, 'a', '95.24.1.15'), ev(8 * 60, 'a', '89.250.1.1')])), [], 'за 8 часов можно долететь');
});

test('много устройств за 7 дней: одно новое не считается', () => {
  const three = ['a', 'b', 'c'].map((id, i) => ev(i, id, '95.24.1.15'));
  assert.deepEqual(signals(run(three)), []);
  const four = [...three, ev(5, 'd', '95.24.1.15')];
  assert.deepEqual(signals(run(four)), ['manyDevices']);
});

test('две игры одновременно с разных устройств', () => {
  const room = (minutes, visitorId, code) => ev(minutes, visitorId, '95.24.1.15', { type: 'room_create', roomCode: code });
  assert.deepEqual(signals(run([room(0, 'a', '111111'), room(10, 'b', '222222')])), ['parallelGames']);
  assert.deepEqual(signals(run([room(0, 'a', '111111'), room(10, 'a', '222222')])), [], 'то же устройство');
  assert.deepEqual(signals(run([room(0, 'a', '111111'), room(120, 'b', '222222')])), [], 'с большим перерывом');
});

test('разные ОС в один день без основного устройства; с основным — не считается', () => {
  const day = (d) => d * 24 * 60;
  const mixed = [
    ev(day(0), 'a', '95.24.1.15', { os: 'Android 14' }), ev(day(0) + 60, 'b', '95.24.1.15', { os: 'Windows 10', deviceType: 'desktop' }),
    ev(day(1), 'a', '95.24.1.15', { os: 'Android 14' }), ev(day(1) + 60, 'b', '95.24.1.15', { os: 'Windows 10', deviceType: 'desktop' }),
  ];
  assert.ok(signals(run(mixed)).includes('mixedDevices'));
  const withMain = [...mixed, ...Array.from({ length: 10 }, (_, i) => ev(day(2) + i, 'a', '95.24.1.15'))];
  assert.ok(!signals(run(withMain)).includes('mixedDevices'));
});

test('устройства чередуются по времени суток', () => {
  const events = [];
  for (let d = 0; d < 4; d += 1) {
    events.push(ev(d * 24 * 60 + 60, 'a', '95.24.1.15')); // 11:00 по Москве
    events.push(ev(d * 24 * 60 + 13 * 60, 'b', '95.24.1.15')); // 23:00 по Москве
  }
  const result = run(events);
  assert.ok(signals(result).includes('alternation'), JSON.stringify(result.reasons));
});

test('пороги: зелёный, жёлтый, красный; оценка не больше 100', () => {
  const session = (visitorId, ip, from, to) => ({ visitorId, ip, createdAt: at(from), lastSeenAt: at(to), validUntil: at(24 * 60) });
  const room = (minutes, visitorId, ip) => ev(minutes, visitorId, ip, { type: 'room_create', roomCode: String(100000 + minutes) });
  const red = run([room(0, 'a', '95.24.1.15'), room(10, 'b', '89.250.1.1')], [session('a', '95.24.1.15', 0, 60), session('b', '89.250.1.1', 5, 60)]);
  assert.equal(red.level, 'red');
  assert.ok(red.score <= 100);
  assert.equal(run([]).level, 'green');
});

// ---------- В консоли ----------

let server;
let admin;
const as = (ip) => new Browser(server, { headers: { 'X-Forwarded-For': ip } });

before(async () => {
  const adminPasswordHash = await argon2.hash('Admin-Secret-42', { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('sharing', { adminLogin: 'Шаринг_Админ', adminPasswordHash, trustProxyHops: 1 });
  admin = as('192.0.2.1');
  await admin.login('Шаринг_Админ', 'Admin-Secret-42');
});

after(async () => {
  await server.close();
});

test('выключено по умолчанию: оценка не считается; включение — в аудите; «Подозрительные»; скрыть; сервер ничего не ограничивает', async () => {
  // Аккаунт, которым пользуются одновременно в Москве и Санкт-Петербурге и запускают две игры сразу.
  const login = uniqueLogin('Shared');
  const moscow = as('95.24.1.15');
  await moscow.register(login, 'shared-password-1');
  const spb = as('178.66.10.5');
  await spb.login(login, 'shared-password-1');
  const quiz = { title: 'Общая', questions: [{ text: 'Q?', answers: ['A', 'B'], correct: 0, timeLimit: 30, readTime: 0 }] };
  for (const browser of [moscow, spb]) {
    const socket = await browser.socket();
    assert.equal((await socket.timeout(3000).emitWithAck('host:create', { quiz })).ok, true);
    socket.disconnect();
  }
  const honest = as('95.24.2.20');
  await honest.register(uniqueLogin('Honest'), 'honest-password-1');

  let computed = 0;
  const factory = server.sharing.geoLookupFactory;
  server.sharing.geoLookupFactory = () => {
    computed += 1;
    return factory();
  };

  const off = await admin.json('/api/admin/accounts');
  assert.equal(off.data.sharing, null);
  assert.ok(off.data.items.every((item) => item.sharing === undefined));
  assert.equal((await admin.json('/api/admin/accounts?suspicious=1')).status, 409);
  assert.equal(computed, 0, 'при выключенных подсказках анализ не запускается');
  assert.equal((await admin.json('/api/admin/settings')).data.sharingHints, false);

  const user = as('198.51.100.7');
  await user.register(uniqueLogin('Nosy'), 'nosy-password-1');
  assert.equal((await user.json('/api/admin/settings/sharing', { method: 'POST', body: { enabled: true } })).status, 403);

  assert.equal((await admin.json('/api/admin/settings/sharing', { method: 'POST', body: { enabled: true } })).data.sharingHints, true);
  const audit = await admin.json('/api/admin/audit');
  assert.ok(audit.data.items.some((entry) => entry.action === 'settings.update' && entry.details.value === true));

  const on = await admin.json('/api/admin/accounts');
  assert.ok(on.data.sharing.analyzed >= 2);
  const shared = on.data.items.find((item) => item.login === login);
  assert.equal(shared.sharing.level, 'red', JSON.stringify(shared.sharing));
  assert.ok(shared.sharing.reasons.some((reason) => reason.signal === 'parallelGames'));
  assert.ok(shared.sharing.reasons.some((reason) => reason.signal === 'concurrent'));
  assert.equal(on.data.items.find((item) => item.login !== login && item.sharing)?.sharing.level ?? 'green', 'green');

  const suspicious = await admin.json('/api/admin/accounts?suspicious=1');
  assert.deepEqual(suspicious.data.items.map((item) => item.login), [login]);

  // «Подозрительный» пользователь работает как обычно: сервер по подсказкам ничего не делает.
  assert.equal((await moscow.json('/api/quizzes')).status, 200);
  assert.equal((await spb.json('/api/quizzes', { method: 'POST', body: quiz })).status, 201);
  assert.equal((await server.db.one('SELECT count(*)::int AS n FROM bans')).n, 0);
  assert.equal((await server.db.one("SELECT count(*)::int AS n FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE a.login = $1 AND s.revoked_at IS NULL", [login])).n, 2);

  // Скрыть из списка.
  assert.equal((await admin.json(`/api/admin/accounts/${shared.id}/sharing-hidden`, { method: 'POST', body: { hidden: true } })).data.hidden, true);
  assert.deepEqual((await admin.json('/api/admin/accounts?suspicious=1')).data.items, []);
  const card = await admin.json(`/api/admin/accounts/${shared.id}`);
  assert.equal(card.data.sharing.hidden, true);
  await admin.json(`/api/admin/accounts/${shared.id}/sharing-hidden`, { method: 'POST', body: { hidden: false } });

  const recompute = await admin.json('/api/admin/sharing/recompute', { method: 'POST' });
  assert.equal(recompute.data.flagged, 1);

  await admin.json('/api/admin/settings/sharing', { method: 'POST', body: { enabled: false } });
  assert.equal((await admin.json('/api/admin/accounts')).data.sharing, null);
});
