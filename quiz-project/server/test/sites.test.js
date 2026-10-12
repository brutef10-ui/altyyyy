import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { io as connect } from 'socket.io-client';
import { startServer } from '../server.js';

// Режим SERVE_SITES: один сервис отдаёт и API, и оба сайта.
let server;
let tempDir;

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'alstudio-sites-'));
  server = await startServer({ port: 0, dataFile: path.join(tempDir, 'quizzes.json'), serveSites: true });
});

after(async () => {
  await server.close();
  await rm(tempDir, { recursive: true, force: true });
});

function tryConnect(origin) {
  return new Promise((resolve) => {
    const socket = connect(server.url, { transports: ['websocket'], forceNew: true, reconnection: false, extraHeaders: { Origin: origin } });
    socket.once('connect', () => {
      socket.disconnect();
      resolve(true);
    });
    socket.once('connect_error', () => resolve(false));
  });
}

test('сайт игрока отдаётся с корня, сайт ведущего — с /host/', async () => {
  const player = await fetch(`${server.url}/`);
  assert.equal(player.status, 200);
  assert.match(await player.text(), /Вход в игру/);

  const host = await fetch(`${server.url}/host/`);
  assert.equal(host.status, 200);
  assert.match(await host.text(), /Мои игры/);

  const redirect = await fetch(`${server.url}/host`, { redirect: 'manual' });
  assert.equal(redirect.status, 301);
});

test('config.js сайтов указывает на тот же адрес', async () => {
  for (const file of ['/js/config.js', '/host/js/config.js']) {
    const response = await fetch(server.url + file);
    assert.match(response.headers.get('content-type'), /javascript/);
    assert.match(await response.text(), /const PRODUCTION_SERVER_URL = window\.location\.origin;/);
  }
});

test('API и health работают рядом с сайтами', async () => {
  assert.equal((await fetch(`${server.url}/health`)).status, 200);
  const config = await (await fetch(`${server.url}/api/config`)).json();
  assert.equal(config.playerSiteUrl, null, 'без адреса лобби возьмёт адрес страницы');
});

test('Socket.IO принимает страницы с того же адреса и отклоняет чужие', async () => {
  assert.equal(await tryConnect(`http://localhost:${server.port}`), true);
  assert.equal(await tryConnect('https://evil.example'), false);
});
