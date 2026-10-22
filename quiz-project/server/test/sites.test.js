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
  for (const page of ['editor.html', 'lobby.html', 'game.html', 'results.html', 'account.html']) {
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

test('политика конфиденциальности открыта без входа и описывает данные', async () => {
  const response = await fetch(`${server.url}/privacy.html`);
  assert.equal(response.status, 200);
  const html = await response.text();
  assert.match(html, /Политика конфиден(&shy;)?циальности/);
  assert.match(html, /support\.alluminous@gmail\.com/);
  assert.match(html, /drive\.file/);
  assert.match(html, /180 дней/);
  // Согласие при входе в игру — отдельный пункт; фото не храним; без подробностей о хранении паролей.
  assert.match(html, /id="consent"[^>]*>2\. Согласие при входе в игру/);
  assert.match(html, /Входя в игру, вы соглашаетесь, что сервер сохраняет ник, IP-адрес, тип устройства и браузер/);
  assert.match(html, /Фото игроков мы не храним/);
  // Оплата: отдельный пункт, чек — не дольше 2 суток, данные об оплате в безопасности.
  assert.match(html, /id="payment"[^>]*>4\. Оплата и чеки/);
  assert.match(html, /Чек хранится не дольше 2 суток/);
  assert.match(html, /Ваши данные об оплате в безопасности/);
  assert.doesNotMatch(html, /хэш|argon|картинк/i);
  // Ссылки на неё — с главной игрока (на пункт о согласии) и со страницы входа ведущего.
  assert.match(await (await fetch(`${server.url}/`)).text(), /href="privacy\.html#consent"/);
  assert.match(await (await fetch(`${server.url}/host/login.html`)).text(), /href="\.\.\/privacy\.html"/);
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

test('общие файлы дизайна одинаковы во всех сайтах', async () => {
  const { readFile } = await import('node:fs/promises');
  const path = await import('node:path');
  const root = path.resolve(import.meta.dirname, '..', '..');
  const same = async (files) => {
    const [first, ...rest] = await Promise.all(files.map((file) => readFile(path.join(root, file), 'utf8')));
    rest.forEach((content, index) => assert.equal(content, first, `${files[index + 1]} отличается от ${files[0]}`));
  };
  await same(['host-site/css/theatre.css', 'player-site/css/theatre.css', 'admin-site/css/theatre.css']);
  await same(['host-site/js/theatre.js', 'player-site/js/theatre.js', 'admin-site/js/theatre.js']);
  await same(['host-site/js/banned.js', 'player-site/js/banned.js']);
});
