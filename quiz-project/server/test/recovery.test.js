import { test, before, after, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import argon2 from 'argon2';
import { Browser, startTestServer, uniqueLogin } from './helpers.js';

// Восстановление доступа: резервный код, одноразовый код от администратора, лимиты, аудит.
let server;
let admin;
const ADMIN_LOGIN = 'Главный_Админ';
const ADMIN_PASSWORD = 'Admin-Secret-42';

before(async () => {
  const adminPasswordHash = await argon2.hash(ADMIN_PASSWORD, { type: argon2.argon2id, memoryCost: 19_456, timeCost: 2, parallelism: 1 });
  server = await startTestServer('recovery', { adminLogin: ADMIN_LOGIN, adminPasswordHash, recoveryCodeTtlMinutes: 30 });
  admin = new Browser(server);
  assert.equal((await admin.login(ADMIN_LOGIN, ADMIN_PASSWORD)).status, 200);
});

after(async () => {
  await server.close();
});

// Все тесты идут с одного IP: счётчики попыток восстановления у каждого теста свои.
beforeEach(async () => {
  await server.db.query("DELETE FROM auth_throttle WHERE key LIKE 'recover:%'");
});

const recover = (browser, login, code, newPassword = 'fresh-password-9') =>
  browser.json('/api/auth/recover', { method: 'POST', body: { login, code, newPassword } });

async function freshBrowser() {
  const browser = new Browser(server);
  await browser.session();
  return browser;
}

async function user() {
  const browser = new Browser(server);
  const login = uniqueLogin('Rec');
  const { backupCode, account } = await browser.register(login, 'first-password-1');
  return { browser, login, backupCode, account };
}

test('резервный код: сброс пароля, код одноразовый, старые сессии отозваны', async () => {
  const { browser: laptop, login, backupCode } = await user();
  const phone = new Browser(server);
  await phone.login(login, 'first-password-1');

  const stranger = await freshBrowser();
  const reset = await recover(stranger, login.toUpperCase(), backupCode.toLowerCase().replace(/-/g, ' '));
  assert.equal(reset.status, 200, JSON.stringify(reset.data));
  assert.match(reset.data.backupCode, /^[A-Z2-9]{5}(-[A-Z2-9]{5}){3}$/);
  assert.notEqual(reset.data.backupCode, backupCode);
  assert.equal((await stranger.session()).account.login, login, 'после сброса — вход в аккаунт');

  assert.equal((await laptop.session()).account, null, 'старые сессии отозваны');
  assert.equal((await phone.session()).account, null);
  assert.equal((await new Browser(server).login(login, 'first-password-1')).status, 401);
  assert.equal((await new Browser(server).login(login, 'fresh-password-9')).status, 200);

  const again = await recover(await freshBrowser(), login, backupCode, 'another-password-3');
  assert.equal(again.data.code, 'BAD_RECOVERY', 'использованный резервный код больше не действует');
  const second = await recover(await freshBrowser(), login, reset.data.backupCode, 'another-password-3');
  assert.equal(second.status, 200, 'новый резервный код действует');
});

test('ошибки не выдают, существует ли логин; неверный пароль проверяется до кода', async () => {
  const { login } = await user();
  const browser = await freshBrowser();
  const unknown = await recover(browser, 'no-such-user', 'AAAAA-BBBBB-CCCCC-DDDDD');
  const wrong = await recover(browser, login, 'AAAAA-BBBBB-CCCCC-DDDDD');
  assert.equal(unknown.status, 401);
  assert.deepEqual(unknown.data, wrong.data);
  assert.equal((await recover(browser, login, 'AAAAA-BBBBB-CCCCC-DDDDD', 'short')).data.code, 'BAD_PASSWORD');
  assert.equal((await recover(browser, ADMIN_LOGIN, 'AAAAA-BBBBB-CCCCC-DDDDD')).data.code, 'BAD_RECOVERY', 'админ не восстанавливается кодом');
});

test('подбор кода ограничен', async () => {
  const { login } = await user();
  const browser = await freshBrowser();
  const statuses = [];
  for (let i = 0; i < 6; i += 1) statuses.push((await recover(browser, login, `AAAAA-BBBBB-CCCCC-DDDD${'EFGHJK'[i]}`)).status);
  assert.deepEqual(statuses.slice(0, 4), [401, 401, 401, 401]);
  assert.equal(statuses[4], 429);
  assert.equal(statuses[5], 429);
});

test('код от администратора: только админ, один раз показан, хэш в БД, аудит', async () => {
  const { login, account } = await user();
  const path = `/api/admin/accounts/${account.id}/recovery-code`;

  assert.equal((await (await freshBrowser()).json(path, { method: 'POST' })).status, 401, 'аноним');
  const regular = new Browser(server);
  await regular.register(uniqueLogin('Plain'), 'plain-password-1');
  assert.equal((await regular.json(path, { method: 'POST' })).status, 403, 'обычный пользователь');
  assert.equal((await regular.json('/api/admin/diagnostics/ip')).status, 403);
  assert.equal((await admin.json(path, { method: 'POST', csrf: false })).status, 403, 'без CSRF-токена');

  const first = await admin.json(path, { method: 'POST' });
  assert.equal(first.status, 201);
  assert.match(first.data.code, /^[A-Z2-9]{5}-[A-Z2-9]{5}-[A-Z2-9]{2}$/);
  assert.equal(first.data.ttlMinutes, 30);
  const minutes = (Date.parse(first.data.expiresAt) - Date.now()) / 60_000;
  assert.ok(minutes > 29 && minutes <= 30, `срок ${minutes} мин`);

  const stored = await server.db.many('SELECT code_hash FROM recovery_codes WHERE account_id = $1', [account.id]);
  assert.deepEqual(stored[0].code_hash, createHash('sha256').update(first.data.code.replace(/-/g, '')).digest());
  const auditRows = await server.db.many("SELECT admin_login, action, details::text AS details FROM admin_audit WHERE target_id = $1", [account.id]);
  assert.equal(auditRows.length, 1);
  assert.equal(auditRows[0].admin_login, ADMIN_LOGIN);
  assert.equal(auditRows[0].action, 'recovery_code.issue');
  assert.ok(!auditRows[0].details.includes(first.data.code.replace(/-/g, '')) && !auditRows[0].details.includes(first.data.code), 'код не попадает в аудит');

  // Новый код отзывает прежний.
  const second = await admin.json(path, { method: 'POST' });
  assert.equal((await recover(await freshBrowser(), login, first.data.code)).data.code, 'BAD_RECOVERY');
  const used = await recover(await freshBrowser(), login, second.data.code);
  assert.equal(used.status, 200);
  assert.ok(used.data.backupCode, 'после сброса — новый резервный код');
  assert.equal((await recover(await freshBrowser(), login, second.data.code, 'other-password-5')).data.code, 'BAD_RECOVERY', 'код одноразовый');

  const adminSelf = await admin.json(`/api/admin/accounts/${admin.account.id}/recovery-code`, { method: 'POST' });
  assert.equal(adminSelf.data.code, 'ADMIN_MANAGED');
  assert.equal((await admin.json('/api/admin/accounts/not-a-uuid/recovery-code', { method: 'POST' })).status, 404);
});

test('код от администратора: истекает и сгорает после 5 неверных попыток', async () => {
  const { login, account } = await user();
  const path = `/api/admin/accounts/${account.id}/recovery-code`;

  const expiring = await admin.json(path, { method: 'POST' });
  await server.db.query("UPDATE recovery_codes SET expires_at = now() - interval '1 second' WHERE account_id = $1", [account.id]);
  assert.equal((await recover(await freshBrowser(), login, expiring.data.code)).data.code, 'BAD_RECOVERY', 'истёкший код');

  const issued = await admin.json(path, { method: 'POST' });
  await server.db.query("DELETE FROM auth_throttle WHERE key LIKE 'recover:%'");
  const attacker = await freshBrowser();
  const statuses = [];
  for (let i = 0; i < 5; i += 1) statuses.push((await recover(attacker, login, `ZZZZZ-ZZZZZ-Z${i + 2}`)).status);
  assert.deepEqual(statuses, [401, 401, 401, 401, 429], 'пятая неудача — ещё и блокировка по IP');
  const row = await server.db.one('SELECT attempts, revoke_reason FROM recovery_codes WHERE account_id = $1 ORDER BY created_at DESC LIMIT 1', [account.id]);
  assert.equal(row.revoke_reason, 'too-many-attempts');
  await server.db.query("DELETE FROM auth_throttle WHERE key LIKE 'recover:%'");
  assert.equal((await recover(await freshBrowser(), login, issued.data.code)).data.code, 'BAD_RECOVERY', 'код сгорел после 5 неверных попыток');
});

test('выход на всех устройствах', async () => {
  const { browser: laptop, login } = await user();
  const phone = new Browser(server);
  await phone.login(login, 'first-password-1');
  assert.equal((await phone.json('/api/auth/logout-all', { method: 'POST' })).status, 204);
  assert.equal((await laptop.session()).account, null);
  assert.equal((await phone.session()).account, null);
});

test('диагностика IP доступна администратору', async () => {
  const response = await admin.json('/api/admin/diagnostics/ip', { headers: { 'X-Forwarded-For': '6.6.6.6' } });
  assert.equal(response.status, 200);
  assert.deepEqual(response.data.xForwardedFor, ['6.6.6.6']);
  assert.equal(response.data.trustProxyHops, 0);
  assert.notEqual(response.data.computedIp, '6.6.6.6', 'без доверенных прокси заголовок не используется');
});
