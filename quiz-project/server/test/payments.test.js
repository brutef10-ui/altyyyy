import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import argon2 from 'argon2';
import { io as connect } from 'socket.io-client';
import { Browser, startTestServer, uniqueLogin } from './helpers.js';

// Оплата доступа: без чека — только демо; чек открывает доступ сразу; чек виден администратору 2 суток.
let server;
let admin;
const ADMIN_LOGIN = 'Касса_Админ';
const ADMIN_PASSWORD = 'Cashier-Admin-2026';
let ip = 0;
const browser = () => new Browser(server, { headers: { 'X-Forwarded-For': `203.0.113.${++ip}`, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0 Mobile Safari/537.36' } });
const quiz = { title: 'Своя игра', questions: [{ type: 'choice', text: 'Q?', answers: ['A', 'B'], correct: 0, timeLimit: 10, readTime: 0 }] };
const png = () => {
  const bytes = Buffer.alloc(600, 3);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const upload = (who, body, type = 'image/png') => who.fetch('/api/payments/receipt', { method: 'POST', headers: { 'Content-Type': type }, body, raw: true });

function socketOf(who) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.url, { extraHeaders: { Origin: who.origin, Cookie: who.cookie(), ...who.headers }, transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}
const emit = (socket, event, payload) => socket.timeout(3000).emitWithAck(event, payload);

before(async () => {
  const adminPasswordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('payments', { paymentRequired: true, adminLogin: ADMIN_LOGIN, adminPasswordHash, trustProxyHops: 1 });
  admin = browser();
  assert.equal((await admin.login(ADMIN_LOGIN, ADMIN_PASSWORD)).status, 200);
});

after(async () => {
  await server.close();
});

test('без оплаты: только демо, и его вопросы изменить нельзя; своя игра — 402', async () => {
  const host = browser();
  await host.register(uniqueLogin('Free'), 'free-password-1');
  const session = await host.session();
  assert.deepEqual(session.payment, { required: true, amount: 100, currency: 'сом', canCreate: false });

  const saved = await host.json('/api/quizzes', { method: 'POST', body: quiz });
  assert.equal(saved.status, 402);
  assert.equal(saved.data.code, 'PAYMENT_REQUIRED');
  assert.equal((await host.json('/api/quizzes')).status, 200, 'список своих игр смотреть можно');

  const socket = await socketOf(host);
  assert.equal((await emit(socket, 'host:create', { quiz })).code, 'PAYMENT_REQUIRED');
  // Демо — с сервера: присланные вместе с ним вопросы игнорируются.
  const demo = await emit(socket, 'host:create', { demo: true, quiz });
  assert.equal(demo.ok, true, demo.error);
  assert.equal(demo.snapshot.title, 'Разминка: обо всём понемногу');
  assert.equal(demo.snapshot.totalQuestions, 7, 'все вопросы демо, а не присланные');
  await emit(socket, 'host:close');
  socket.disconnect();
});

test('чек: неподходящий файл отклоняется; верный — доступ сразу; второй раз — 409', async () => {
  const host = browser();
  const login = uniqueLogin('Payer');
  await host.register(login, 'payer-password-1');
  await host.session();

  assert.equal((await upload(host, Buffer.from('<html>not a receipt at all</html>'), 'image/png')).status, 415);
  assert.equal((await upload(host, Buffer.from('%PDF-1.7 fake but looks like pdf header'), 'application/pdf')).status, 201);
  const session = await host.session();
  assert.equal(session.payment.canCreate, true);
  assert.equal((await host.json('/api/quizzes', { method: 'POST', body: quiz })).status, 201);
  const socket = await socketOf(host);
  const room = await emit(socket, 'host:create', { quiz });
  assert.equal(room.ok, true, room.error);
  await emit(socket, 'host:close');
  socket.disconnect();

  const again = await upload(host, png());
  assert.equal(again.status, 409);
  assert.equal((await again.json()).code, 'ALREADY_PAID');
  // Гость и администратор чек прикрепить не могут.
  assert.equal((await fetch(`${server.url}/api/payments/receipt`, { method: 'POST', headers: { 'Content-Type': 'image/png' }, body: png() })).status, 401);
  assert.equal((await upload(admin, png())).status, 403);

  const event = await server.db.one("SELECT account_login, ip::text AS ip, browser FROM events WHERE type = 'payment_receipt' ORDER BY id DESC LIMIT 1");
  assert.equal(event.account_login, login);
  assert.match(event.browser, /Chrome/);
});

test('консоль: кто оплатил — логин, время, IP, браузер, чек; чек открывается только администратору', async () => {
  const host = browser();
  const login = uniqueLogin('Shown');
  await host.register(login, 'shown-password-1');
  await host.session();
  const file = png();
  assert.equal((await upload(host, file)).status, 201);

  const { data } = await admin.json('/api/admin/payments');
  const item = data.items.find((row) => row.login === login);
  assert.ok(item, 'оплата видна в консоли');
  assert.match(item.ip, /^203\.0\.113\./);
  assert.equal(item.deviceType, 'mobile');
  assert.match(item.browser, /Chrome/);
  assert.deepEqual(item.receipt, { type: 'image/png', size: file.length });
  assert.equal(item.amount, 100);

  const receipt = await admin.fetch(`/api/admin/payments/${item.id}/receipt`);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.headers.get('content-type'), 'image/png');
  assert.match(receipt.headers.get('content-security-policy'), /sandbox/);
  assert.ok(Buffer.from(await receipt.arrayBuffer()).equals(file));
  assert.equal((await host.fetch(`/api/admin/payments/${item.id}/receipt`)).status, 403);
  assert.equal((await host.fetch('/api/admin/payments')).status, 403);
  const audit = await server.db.one("SELECT details->>'login' AS login FROM admin_audit WHERE action = 'payment.receipt.view' ORDER BY id DESC LIMIT 1");
  assert.equal(audit.login, login);
  assert.ok((await admin.json('/api/admin/overview')).data.payments >= 1);
});

test('чек хранится не дольше 2 суток; факт оплаты остаётся; в резервную копию чеки не попадают', async () => {
  const host = browser();
  const login = uniqueLogin('Old');
  await host.register(login, 'old-password-1');
  await host.session();
  assert.equal((await upload(host, png())).status, 201);
  const { id } = await server.db.one('SELECT p.id FROM payments p JOIN accounts a ON a.id = p.account_id WHERE a.login = $1', [login]);
  await server.db.query("UPDATE payments SET created_at = now() - interval '48 hours 1 minute' WHERE id = $1", [id]);

  assert.equal((await admin.fetch(`/api/admin/payments/${id}/receipt`)).status, 404, 'просроченный чек не отдаётся даже до уборки');
  const purged = await new (await import('../src/payments.js')).PaymentService(server.db).purgeReceipts();
  assert.ok(purged >= 1);
  const row = await server.db.one('SELECT receipt, receipt_deleted_at FROM payments WHERE id = $1', [id]);
  assert.equal(row.receipt, null);
  assert.ok(row.receipt_deleted_at);
  const { data } = await admin.json('/api/admin/payments');
  const item = data.items.find((entry) => entry.id === id);
  assert.equal(item.receipt, null);
  assert.ok(item.receiptDeletedAt);

  const { BACKUP_TABLES } = await import('../src/backup/dump.js');
  assert.ok(!BACKUP_TABLES.some((table) => table.name === 'payments'));
});

test('доступ — только после чека: у любого аккаунта без оплаты, в том числе старого, доступа нет', async () => {
  const hash = await argon2.hash('legacy-password-1', { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  const login = uniqueLogin('Before');
  // Аккаунт, созданный в обход регистрации (как старые строки в базе): столбец доступа не указан.
  await server.db.query('INSERT INTO accounts (login, login_normalized, password_hash) VALUES ($1, lower($1), $2)', [login, hash]);
  const host = browser();
  assert.equal((await host.login(login, 'legacy-password-1')).status, 200);
  assert.equal((await host.session()).payment.canCreate, false);
  assert.equal((await host.json('/api/quizzes', { method: 'POST', body: quiz })).status, 402);
  assert.equal((await upload(host, png())).status, 201);
  assert.equal((await host.session()).payment.canCreate, true);
  assert.equal((await host.json('/api/quizzes', { method: 'POST', body: quiz })).status, 201);
});
