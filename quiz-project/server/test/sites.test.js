import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { io as connect } from 'socket.io-client';
import { hostBrowser, startTestServer } from './helpers.js';

// Режим SERVE_SITES: один сервис отдаёт и API, и оба сайта.
let server;

before(async () => {
  server = await startTestServer('sites', { serveSites: true });
});

after(async () => {
  await server.close();
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

  // Страницы ведущего — только после входа; без входа — переход на страницу входа.
  const anonymous = await fetch(`${server.url}/host/`, { redirect: 'manual' });
  assert.equal(anonymous.status, 302);
  assert.equal(anonymous.headers.get('location'), '/host/login.html?next=%2Fhost%2F');
  for (const page of ['editor.html', 'lobby.html', 'game.html', 'results.html']) {
    assert.equal((await fetch(`${server.url}/host/${page}`, { redirect: 'manual' })).status, 302, page);
  }
  assert.equal((await fetch(`${server.url}/host/login.html`)).status, 200);

  const browser = await hostBrowser(server);
  const host = await browser.fetch('/host/');
  assert.equal(host.status, 200);
  assert.match(await host.text(), /Мои игры/);

  const redirect = await browser.fetch('/host');
  assert.equal(redirect.status, 301);
  assert.equal((await fetch(`${server.url}/host`, { redirect: 'manual' })).status, 302, 'без входа — на страницу входа');
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
