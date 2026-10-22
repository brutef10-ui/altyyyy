import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { Browser, TEST_DATABASE_URL, startTestServer, uniqueLogin } from './helpers.js';
import { createDb } from '../src/db/index.js';
import { createBackup, readBackup, tableDigests } from '../src/backup/dump.js';
import { parseKey } from '../src/backup/crypto.js';
import { restoreBackup, restoreCheck } from '../src/backup/restore.js';
import { GoogleDriveStorage, LocalDirStorage } from '../src/backup/storage.js';
import { BackupScheduler } from '../src/backup/scheduler.js';

// Резервные копии: создание, шифрование, проверка восстановления, расписание, Google Drive (поддельный).
let server;
let dir;
const KEY_HEX = randomBytes(32).toString('hex');
const key = parseKey(KEY_HEX);
const jpeg = () => {
  const bytes = randomBytes(3000);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

before(async () => {
  server = await startTestServer('backup', { trustProxyHops: 1 });
  dir = await mkdtemp(path.join(os.tmpdir(), 'luminous-backup-test-'));
  // Немного живых данных во всех таблицах.
  const host = new Browser(server, { headers: { 'X-Forwarded-For': '203.0.113.5' } });
  await host.register(uniqueLogin('Backup'), 'backup-password-1');
  // Картинка, загруженная до отключения картинок к вопросам: таблица images по-прежнему входит в копию.
  await server.db.query("INSERT INTO images (id, account_id, content_type, bytes, size) VALUES ($1, $2, 'image/jpeg', $3, 3000)", [randomBytes(16).toString('hex'), host.account.id, jpeg()]);
  await host.json('/api/quizzes', { method: 'POST', body: { title: 'Копия «с кавычками» и \\ слэшем', questions: [{ text: 'Q?\nвторая строка', answers: ['A', 'B'], correct: 0, timeLimit: 10, readTime: 0 }] } });
  await server.db.query("INSERT INTO bans (ip, reason, ends_at) VALUES ('198.51.100.1', 'Тест', now() + interval '1 day')");
  await server.db.query("INSERT INTO admin_audit (action, details) VALUES ('test.action', '{\"a\": [1, 2, {\"b\": null}]}')");
  await server.db.query("INSERT INTO settings (key, value) VALUES ('sharing_hints', '{\"enabled\": true}')");
  await server.db.query(
    "INSERT INTO legacy_quizzes (id, device_owner, title, data, created_at, updated_at) VALUES ('11111111-2222-4333-8444-555555555555', 'device:x', 'Старая', '{\"title\":\"Старая\",\"questions\":[]}', now(), now())",
  );
});

after(async () => {
  await server.close();
  await rm(dir, { recursive: true, force: true });
});

test('бэкап: все таблицы, сводка, проверка восстановления во временной схеме', async () => {
  const file = path.join(dir, 'one.alsb');
  const { manifest, schemaVersion } = await createBackup(server.db, file, key);
  assert.ok(schemaVersion >= 5);
  assert.equal(manifest.images.count, 1);
  assert.equal(manifest.quizzes.count, 1);
  assert.ok(manifest.events.count >= 2);
  const raw = await readFile(file);
  assert.equal(raw.subarray(0, 4).toString(), 'ALSB');
  assert.ok(!raw.includes(Buffer.from('backup-password')) && !raw.includes(Buffer.from('Копия')), 'файл зашифрован');

  const read = await readBackup(file, key);
  assert.deepEqual(read.manifest, manifest);
  const live = await tableDigests(server.db);
  for (const [table, item] of Object.entries(manifest)) assert.deepEqual(live.tables[table], item, table);

  const check = await restoreCheck({ url: TEST_DATABASE_URL, ssl: 'disable', file, key, log: null });
  assert.equal(check.ok, true, check.problems.join('; '));
});

test('восстановление: картинки байт в байт, счётчики id продолжаются, непустую базу не трогает', async () => {
  const file = path.join(dir, 'two.alsb');
  await createBackup(server.db, file, key);
  const schema = `t_restore_${randomBytes(3).toString('hex')}`;
  const target = createDb({ url: TEST_DATABASE_URL, ssl: 'disable', schema });
  try {
    await restoreBackup(target, file, key, { log: null });
    const original = await server.db.one('SELECT bytes FROM images');
    const restored = await target.one('SELECT bytes FROM images');
    assert.ok(restored.bytes.equals(original.bytes));
    const title = await target.one('SELECT title FROM quizzes');
    assert.equal(title.title, 'Копия «с кавычками» и \\ слэшем');
    const maxId = (await target.one('SELECT max(id)::int AS id FROM events')).id;
    const next = await target.one("INSERT INTO events (type) VALUES ('after_restore') RETURNING id");
    assert.ok(next.id > maxId, 'последовательность id восстановлена');
    await assert.rejects(restoreBackup(target, file, key, { log: null }), /не пуста/);
  } finally {
    await target.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await target.close();
  }
});

test('подменённый файл и неверный ключ: восстановление отклоняется, база не меняется', async () => {
  const file = path.join(dir, 'three.alsb');
  await createBackup(server.db, file, key);
  const bytes = await readFile(file);
  bytes[Math.floor(bytes.length / 2)] ^= 0xff;
  const broken = path.join(dir, 'broken.alsb');
  await writeFile(broken, bytes);
  await assert.rejects(readBackup(broken, key));
  await assert.rejects(readBackup(file, parseKey(randomBytes(32).toString('hex'))));
  assert.throws(() => parseKey('short'), /32 байта/);

  const schema = `t_restore_${randomBytes(3).toString('hex')}`;
  const target = createDb({ url: TEST_DATABASE_URL, ssl: 'disable', schema });
  try {
    await assert.rejects(restoreBackup(target, broken, key, { log: null }));
    const { n } = await target.one('SELECT count(*)::int AS n FROM accounts');
    assert.equal(n, 0, 'транзакция откатилась');
  } finally {
    await target.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
    await target.close();
  }
});

test('расписание: копия в хранилище, проверка после загрузки, хранятся последние N', async () => {
  const storageDir = path.join(dir, 'storage');
  const scheduler = new BackupScheduler({ db: server.db, storage: new LocalDirStorage(storageDir), encryptionKey: KEY_HEX, keep: 2, log: null });
  assert.equal(await scheduler.status(), null);
  for (let i = 0; i < 3; i += 1) {
    const state = await scheduler.run();
    assert.equal(state.ok, true, state.error);
    assert.equal(state.verified, true);
    await new Promise((resolve) => setTimeout(resolve, 1100)); // имена файлов — с точностью до секунды
  }
  assert.equal((await readdir(storageDir)).length, 2, 'старые копии удалены');
  const status = await scheduler.status();
  assert.ok(status.successAt && status.rows > 0);
  assert.equal(await scheduler.runIfDue(), null, 'следующая — через сутки');

  // Ошибка хранилища записывается в состояние, прежняя удачная копия остаётся видна.
  const failing = new BackupScheduler({ db: server.db, storage: { upload: async () => { throw new Error('нет места'); }, list: async () => [] }, encryptionKey: KEY_HEX, log: null });
  const failed = await failing.run();
  assert.equal(failed.ok, false);
  assert.match(failed.error, /нет места/);
  assert.equal(failed.successAt, status.successAt);
});

test('Google Drive: токен, папка, загрузка, список, скачивание, удаление (поддельный сервер)', async () => {
  const files = new Map();
  const log = [];
  let uploadName = null;
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks);
    const url = new URL(req.url, 'http://x');
    log.push(`${req.method} ${url.pathname}`);
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/token') {
      const form = new URLSearchParams(body.toString());
      if (form.get('refresh_token') !== 'refresh-ok') return json(400, { error: 'invalid_grant' });
      return json(200, { access_token: 'access-1', expires_in: 3600 });
    }
    if (req.headers.authorization !== 'Bearer access-1' && !url.pathname.startsWith('/session')) return json(401, { error: 'no' });
    if (url.pathname === '/api/files' && req.method === 'GET' && url.searchParams.get('q').includes('google-apps.folder')) return json(200, { files: [] });
    if (url.pathname === '/api/files' && req.method === 'POST') return json(200, { id: 'folder-1' });
    if (url.pathname === '/upload/files' && req.method === 'POST') {
      uploadName = JSON.parse(body.toString()).name;
      res.writeHead(200, { Location: `http://127.0.0.1:${fake.address().port}/session/1` });
      return res.end();
    }
    if (url.pathname === '/session/1' && req.method === 'PUT') {
      files.set('file-1', { name: uploadName, body });
      return json(200, { id: 'file-1', name: uploadName, size: String(body.length) });
    }
    if (url.pathname === '/api/files' && req.method === 'GET') {
      return json(200, { files: [...files].map(([id, file]) => ({ id, name: file.name, size: String(file.body.length), createdTime: new Date().toISOString() })) });
    }
    if (url.pathname === '/api/files/file-1' && req.method === 'GET') {
      res.writeHead(200);
      return res.end(files.get('file-1').body);
    }
    if (url.pathname === '/api/files/file-1' && req.method === 'DELETE') {
      files.delete('file-1');
      res.writeHead(204);
      return res.end();
    }
    return json(404, { error: 'unknown' });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.address().port}`;
  const endpoints = { token: `${base}/token`, api: `${base}/api`, upload: `${base}/upload` };
  try {
    const bad = new GoogleDriveStorage({ clientId: 'c', clientSecret: 's', refreshToken: 'wrong', endpoints });
    await assert.rejects(bad.list(), /invalid_grant/);

    const drive = new GoogleDriveStorage({ clientId: 'c', clientSecret: 's', refreshToken: 'refresh-ok', endpoints });
    const file = path.join(dir, 'drive.alsb');
    await createBackup(server.db, file, key);
    const uploaded = await drive.upload('luminous-test.alsb', file);
    assert.equal(uploaded.id, 'file-1');
    assert.deepEqual((await drive.list()).map((item) => item.name), ['luminous-test.alsb']);
    const copy = path.join(dir, 'drive-copy.alsb');
    await drive.download('file-1', copy);
    assert.ok((await readFile(copy)).equals(await readFile(file)));
    await readBackup(copy, key);
    await drive.remove('file-1');
    assert.deepEqual(await drive.list(), []);
    assert.ok(log.includes('POST /api/files'), 'папка создана');
  } finally {
    fake.close();
  }
});

test('Google Drive: старая папка «AL Studio backups» переименовывается в «Luminous backups», копии ложатся в неё', async () => {
  const seen = { renamed: null, parents: null, query: '' };
  const fake = http.createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = Buffer.concat(chunks).toString();
    const url = new URL(req.url, 'http://x');
    const json = (status, data, headers = {}) => {
      res.writeHead(status, { 'Content-Type': 'application/json', ...headers });
      res.end(JSON.stringify(data));
    };
    if (url.pathname === '/token') return json(200, { access_token: 'access-1', expires_in: 3600 });
    if (url.pathname === '/api/files' && req.method === 'GET') {
      seen.query = url.searchParams.get('q');
      return json(200, { files: [{ id: 'old-1', name: 'AL Studio backups' }] });
    }
    if (url.pathname === '/api/files/old-1' && req.method === 'PATCH') {
      seen.renamed = JSON.parse(body).name;
      return json(200, { id: 'old-1' });
    }
    if (url.pathname === '/upload/files' && req.method === 'POST') {
      seen.parents = JSON.parse(body).parents;
      res.writeHead(200, { Location: `http://127.0.0.1:${fake.address().port}/session/1` });
      return res.end();
    }
    if (url.pathname === '/session/1') return json(200, { id: 'file-1', name: 'x.alsb', size: '1' });
    return json(404, { error: 'unknown' });
  });
  await new Promise((resolve) => fake.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${fake.address().port}`;
  try {
    const drive = new GoogleDriveStorage({ clientId: 'c', clientSecret: 's', refreshToken: 'r', endpoints: { token: `${base}/token`, api: `${base}/api`, upload: `${base}/upload` } });
    const file = path.join(dir, 'old-folder.alsb');
    await writeFile(file, 'x');
    await drive.upload('luminous-test.alsb', file);
    assert.match(seen.query, /name='Luminous backups' or name='AL Studio backups'/);
    assert.equal(seen.renamed, 'Luminous backups');
    assert.deepEqual(seen.parents, ['old-1']);
  } finally {
    fake.close();
  }
});
