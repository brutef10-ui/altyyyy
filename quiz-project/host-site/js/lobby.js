// Лобби: код комнаты, игроки в реальном времени, кнопка «Старт».
import { closeRoom, openHostRoom, request } from './socket.js';
import { avatar, confirmDialog, formatCode, h, plural, toast } from './ui.js';

const QR_LIBRARY = 'https://cdn.jsdelivr.net/npm/qrcode-generator@1.4.4/qrcode.min.js';

const playersList = document.getElementById('players');
const playerCount = document.getElementById('player-count');
const hint = document.getElementById('lobby-hint');
const startButton = document.getElementById('start');
const codeButton = document.getElementById('room-code');

const players = new Map(); // id → { data, node }
let socket = null;
let roomCode = '';
let starting = false;

// ---------- Игроки ----------

function playerChip(player) {
  const node = h('li', { class: 'player-chip is-new', dataset: { id: player.id } },
    h('button', { class: 'player-button', type: 'button', title: `Удалить «${player.nickname}»`, onclick: () => kick(player.id) },
      avatar(player.avatar, player.nickname, 'avatar avatar-lg'),
      h('span', { class: 'player-name', text: player.nickname }),
      h('span', { class: 'player-kick', 'aria-hidden': 'true', text: '✕' }),
    ),
  );
  node.addEventListener('animationend', () => node.classList.remove('is-new'), { once: true });
  node.classList.toggle('is-offline', player.connected === false);
  return node;
}

function addPlayer(player, { animate = true } = {}) {
  if (players.has(player.id)) {
    updatePlayer(player);
    return;
  }
  const node = playerChip(player);
  if (!animate) node.classList.remove('is-new');
  players.set(player.id, { data: player, node });
  playersList.append(node);
}

function updatePlayer(change) {
  const entry = players.get(change.id);
  if (!entry) return;
  Object.assign(entry.data, change);
  entry.node.classList.toggle('is-offline', entry.data.connected === false);
}

function removePlayer(id) {
  const entry = players.get(id);
  if (!entry) return;
  players.delete(id);
  entry.node.classList.add('is-leaving');
  entry.node.addEventListener('animationend', () => entry.node.remove(), { once: true });
}

function updateCounter() {
  const count = players.size;
  playerCount.textContent = count;
  playerCount.classList.remove('bump');
  void playerCount.offsetWidth; // перезапуск анимации
  playerCount.classList.add('bump');
  startButton.disabled = count === 0 || starting;
  hint.textContent = count === 0
    ? 'Ждём игроков…'
    : `${count} ${plural(count, ['игрок готов', 'игрока готовы', 'игроков готовы'])} к игре`;
}

async function kick(playerId) {
  const entry = players.get(playerId);
  if (!entry) return;
  const confirmed = await confirmDialog({
    title: `Удалить «${entry.data.nickname}»?`,
    message: 'Игрок покинет комнату. Он сможет войти снова с другим ником.',
    confirmText: 'Удалить',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await request(socket, 'host:kick', { playerId });
  } catch (error) {
    toast(error.message, 'error');
  }
}

// ---------- Код комнаты и QR ----------

function renderJoinInfo(snapshot) {
  roomCode = snapshot.code;
  codeButton.textContent = formatCode(snapshot.code);
  document.getElementById('quiz-title').textContent = snapshot.title;
  document.title = `Искра — ${formatCode(snapshot.code)}`;

  const url = snapshot.playerSiteUrl;
  document.getElementById('join-url').textContent = url ? url.replace(/^https?:\/\//, '') : 'сайт игрока';
  if (url) renderQr(`${url}/?code=${snapshot.code}`);
}

function loadQrLibrary() {
  if (window.qrcode) return Promise.resolve(window.qrcode);
  return new Promise((resolve, reject) => {
    const script = h('script', { src: QR_LIBRARY, async: true, crossorigin: 'anonymous' });
    script.onload = () => resolve(window.qrcode);
    script.onerror = reject;
    document.head.append(script);
  });
}

// QR-код рисуем сами в SVG по матрице из библиотеки. Если библиотека недоступна — просто без QR.
async function renderQr(text) {
  const container = document.getElementById('qr');
  try {
    const qrcode = await loadQrLibrary();
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const size = qr.getModuleCount();
    const margin = 2;
    let path = '';
    for (let row = 0; row < size; row += 1) {
      for (let col = 0; col < size; col += 1) {
        if (qr.isDark(row, col)) path += `M${col + margin} ${row + margin}h1v1h-1z`;
      }
    }
    const total = size + margin * 2;
    const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
    svg.setAttribute('role', 'img');
    svg.setAttribute('aria-label', `QR-код для входа: ${text}`);
    svg.setAttribute('shape-rendering', 'crispEdges');
    const background = document.createElementNS(svg.namespaceURI, 'rect');
    background.setAttribute('width', total);
    background.setAttribute('height', total);
    background.setAttribute('fill', '#fff');
    const modules = document.createElementNS(svg.namespaceURI, 'path');
    modules.setAttribute('d', path);
    modules.setAttribute('fill', '#14102b');
    svg.append(background, modules);
    container.replaceChildren(svg, h('span', { class: 'qr-caption', text: 'или наведите камеру' }));
    container.hidden = false;
  } catch {
    container.hidden = true;
  }
}

codeButton.addEventListener('click', async () => {
  try {
    await navigator.clipboard.writeText(roomCode);
    toast('Код скопирован');
  } catch {
    /* буфер обмена недоступен */
  }
});

// ---------- Управление ----------

startButton.addEventListener('click', async () => {
  if (starting || players.size === 0) return;
  starting = true;
  startButton.disabled = true;
  startButton.textContent = 'Запускаем…';
  try {
    await request(socket, 'host:start');
    location.href = 'game.html';
  } catch (error) {
    toast(error.message, 'error');
    starting = false;
    startButton.textContent = 'Старт ▶';
    updateCounter();
  }
});

document.getElementById('cancel').addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: 'Отменить игру?',
    message: 'Комната закроется, игроки увидят уведомление.',
    confirmText: 'Отменить игру',
    cancelText: 'Остаться',
    danger: true,
  });
  if (!confirmed) return;
  await closeRoom(socket);
  location.href = 'index.html';
});

// ---------- Подключение ----------

socket = await openHostRoom({
  page: 'lobby.html',
  allowCreate: true,
  onReady(snapshot) {
    renderJoinInfo(snapshot);
    const fresh = new Set(snapshot.players.map((player) => player.id));
    for (const id of [...players.keys()]) if (!fresh.has(id)) removePlayer(id);
    snapshot.players.forEach((player) => addPlayer(player, { animate: false }));
    updateCounter();
  },
});

socket.on('lobby:update', (update) => {
  if (update.action === 'join' && update.player) addPlayer(update.player);
  else if (update.action === 'update' && update.player) updatePlayer(update.player);
  else if (update.action === 'leave') removePlayer(update.playerId);
  updateCounter();
});
