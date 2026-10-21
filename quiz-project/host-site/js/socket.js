// Подключение ведущего к серверу через Socket.IO.
//
// Лобби, игра и итоги — разные страницы, поэтому при каждом переходе соединение создаётся заново.
// Новая страница «возвращает» себе комнату событием host:resume с секретным ключом комнаты,
// а сервер ждёт ведущего несколько секунд, прежде чем закрыть комнату.
//
// Надёжность: временные ошибки (сервер занят, не ответил, внутренняя ошибка) не считаются тупиком —
// страница повторяет попытку с растущей паузой (1, 2, 4, 8, 10 с…), показывая «Переподключаемся…».
// Когда вкладка снова видна или вернулась сеть, переподключаемся сразу, не дожидаясь паузы.
// Пока комната открыта, страница раз в 4 минуты «будит» сервер (бесплатный хостинг иначе засыпает)
// и не даёт экрану телефона погаснуть посреди игры.
import { SERVER_URL } from './config.js';
import { getHostToken } from './api.js';
import { goToLogin } from './auth.js';
import { banFromError, showBanned } from './banned.js';
import { flash, hostSession, launchRequest } from './session.js';
import { hideOverlay, showOverlay } from './ui.js';
import { curtain } from './theatre.js';

const STATE_PAGES = {
  lobby: 'lobby.html',
  question: 'game.html',
  results: 'game.html',
  final: 'results.html',
};

const FATAL_CODES = new Set(['ROOM_NOT_FOUND', 'NO_ROOM', 'INVALID_QUIZ', 'NOT_FOUND', 'UNAUTHORIZED', 'BAD_CODE']);
// Ошибки, после которых имеет смысл просто попробовать ещё раз.
const TRANSIENT_CODES = new Set(['TIMEOUT', 'RATE_LIMIT', 'INTERNAL', 'UNKNOWN']);

const RETRY_BASE_MS = 1_000;
const RETRY_MAX_MS = 10_000;
const KEEP_ALIVE_MS = 4 * 60_000;

let clientLoader = null;
let closingOnPurpose = false;
// Страница сама отказалась от соединения (комнату закрыли, её открыли в другой вкладке, уходим домой).
let stopped = false;
let keepAliveTimer = null;
let wakeLock = null;

const retryDelay = (attempt) => Math.min(RETRY_MAX_MS, RETRY_BASE_MS * 2 ** attempt);
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Клиент Socket.IO отдаёт сам сервер — так версии клиента и сервера всегда совпадают.
function loadClient() {
  if (window.io) return Promise.resolve(window.io);
  clientLoader ??= new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = `${SERVER_URL}/socket.io/socket.io.min.js`;
    script.async = true;
    script.onload = () => resolve(window.io);
    script.onerror = () => {
      clientLoader = null;
      script.remove();
      reject(new Error(`Не удалось подключиться к серверу ${SERVER_URL}.`));
    };
    document.head.append(script);
  });
  return clientLoader;
}

/** Загружает клиент Socket.IO, повторяя попытки: сервер мог «проснуться» не сразу или сеть моргнула. */
async function loadClientWithRetry() {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await loadClient();
    } catch (error) {
      const delay = retryDelay(attempt);
      // После нескольких неудач показываем кнопку «Обновить страницу», но продолжаем пробовать сами.
      showOverlay(`${error.message} Пробуем ещё раз через ${Math.round(delay / 1000)} с…`, { retry: attempt >= 2 });
      await wait(delay);
    }
  }
}

/** Отправляет событие и ждёт ответа сервера. Бросает Error с полем code, если сервер вернул ошибку. */
export async function request(socket, event, payload = {}, timeoutMs = 10_000) {
  let response;
  try {
    response = await socket.timeout(timeoutMs).emitWithAck(event, payload);
  } catch {
    throw Object.assign(new Error('Сервер не ответил. Проверьте соединение.'), { code: 'TIMEOUT' });
  }
  if (!response?.ok) {
    // Сессия истекла или отозвана (выход на другом устройстве, смена пароля): войти заново.
    if (response?.code === 'UNAUTHORIZED') goToLogin();
    if (response?.code === 'BANNED') {
      stop();
      showBanned(response.ban);
    }
    throw Object.assign(new Error(response?.error || 'Ошибка сервера'), { code: response?.code || 'UNKNOWN' });
  }
  return response;
}

export function pageForState(state) {
  return STATE_PAGES[state] || 'index.html';
}

export function goHome(message, type = 'info') {
  stop();
  if (message) flash.set(message, type);
  hostSession.clear();
  curtain.go('index.html');
}

/** Запуск игры: лобби создаст новую комнату с новым кодом. */
export function launchGame({ quizId = null, quiz = null }) {
  launchRequest.set({ quizId, quiz });
  hostSession.clear();
  curtain.go('lobby.html');
}

async function attach(socket, allowCreate) {
  const session = hostSession.get();
  if (session?.code) {
    const { snapshot } = await request(socket, 'host:resume', { code: session.code, hostKey: session.hostKey });
    return { snapshot, session };
  }

  const launch = allowCreate ? launchRequest.get() : null;
  if (!launch) {
    throw Object.assign(new Error('Нет активной игры. Выберите игру и нажмите «Запустить».'), { code: 'NO_ROOM' });
  }
  const created = await request(socket, 'host:create', launch.quiz ? { quiz: launch.quiz } : { quizId: launch.quizId });
  const next = {
    code: created.code,
    hostKey: created.hostKey,
    title: created.snapshot.title,
    quizId: launch.quizId ?? null,
    draft: launch.quiz ?? null,
  };
  hostSession.set(next);
  launchRequest.clear();
  return { snapshot: created.snapshot, session: next };
}

// ---------- Поддержка сервера и экрана «в живых» ----------

function startKeepAlive() {
  if (keepAliveTimer) return;
  keepAliveTimer = setInterval(() => {
    // no-cors: ответ нам не нужен, важно лишь, чтобы запрос дошёл до сервера.
    fetch(`${SERVER_URL}/health`, { cache: 'no-store', mode: 'no-cors' }).catch(() => {});
  }, KEEP_ALIVE_MS);
}

async function keepScreenOn() {
  if (stopped || wakeLock || document.visibilityState !== 'visible' || !navigator.wakeLock) return;
  try {
    wakeLock = await navigator.wakeLock.request('screen');
    wakeLock.addEventListener('release', () => {
      wakeLock = null;
    });
  } catch {
    wakeLock = null; // не поддерживается или запрещено — не страшно
  }
}

function stop() {
  stopped = true;
  clearInterval(keepAliveTimer);
  keepAliveTimer = null;
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

function transientMessage(error, delay) {
  const seconds = Math.max(1, Math.round(delay / 1000));
  const reason = error.code === 'RATE_LIMIT' ? 'Сервер сейчас перегружен.' : 'Связь с сервером нестабильна.';
  return `${reason} Переподключаемся через ${seconds} с…`;
}

/**
 * Подключает страницу ведущего к комнате.
 * @param {object} options
 * @param {string} options.page — имя текущей страницы (lobby.html, game.html, results.html)
 * @param {boolean} [options.allowCreate] — создать комнату, если её ещё нет (только лобби)
 * @param {(snapshot: object, session: object) => void} options.onReady — после каждого (пере)подключения
 */
export async function openHostRoom({ page, allowCreate = false, onReady }) {
  showOverlay('Подключение к серверу…');
  const io = await loadClientWithRetry();

  // withCredentials — cookie сессии уходит и на сервер с другим адресом (локальная разработка).
  const socket = io(SERVER_URL, {
    withCredentials: true,
    auth: { token: getHostToken() },
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 3000,
  });

  let attempt = 0; // номер повтора после временной ошибки
  let retryTimer = null;
  let generation = 0; // отличает актуальную попытку от устаревших

  const cancelRetry = () => {
    clearTimeout(retryTimer);
    retryTimer = null;
  };

  // Переподключиться прямо сейчас (новое соединение), не дожидаясь паузы Socket.IO.
  const reconnectNow = () => {
    if (stopped) return;
    cancelRetry();
    socket.disconnect().connect();
  };

  async function attachAndRender() {
    cancelRetry();
    const current = ++generation;
    try {
      const { snapshot, session } = await attach(socket, allowCreate);
      if (current !== generation || stopped) return;
      attempt = 0;
      const target = pageForState(snapshot.state);
      if (target !== page) {
        curtain.go(target, { replace: true });
        return;
      }
      hideOverlay();
      startKeepAlive();
      keepScreenOn();
      onReady(snapshot, session);
    } catch (error) {
      if (current !== generation || stopped) return;
      if (error.code === 'BANNED') {
        socket.disconnect();
        hideOverlay();
      } else if (error.code === 'UNAUTHORIZED') {
        // Сессия истекла или из неё вышли в другой вкладке: войти заново и вернуться сюда.
        stop();
        socket.disconnect();
        goToLogin();
      } else if (FATAL_CODES.has(error.code)) {
        goHome(error.message, 'error');
      } else if (TRANSIENT_CODES.has(error.code)) {
        const delay = retryDelay(attempt);
        attempt += 1;
        showOverlay(transientMessage(error, delay));
        retryTimer = setTimeout(() => {
          retryTimer = null;
          // Сервер не ответил — соединение, скорее всего, «повисло»: открываем новое.
          // Иначе повторяем запрос по живому соединению (или дождёмся события connect).
          if (error.code === 'TIMEOUT' || !socket.connected) reconnectNow();
          else attachAndRender();
        }, delay);
      } else {
        showOverlay(error.message, { error: true, retry: true });
      }
    }
  }

  socket.on('connect', attachAndRender);

  socket.on('connect_error', (error) => {
    const ban = banFromError(error);
    if (ban) {
      // Заблокированного сервер не пускает — переподключаться бессмысленно.
      stop();
      socket.disconnect();
      hideOverlay();
      showBanned(ban);
      return;
    }
    if (!stopped && !retryTimer) showOverlay('Нет связи с сервером. Пробуем переподключиться…');
  });
  // Блокировка во время игры: сервер закрыл комнату и отключил ведущего.
  socket.on('access:banned', (ban) => {
    stop();
    socket.disconnect();
    hideOverlay();
    showBanned(ban);
  });
  socket.on('disconnect', (reason) => {
    generation += 1; // ответ на запрос по старому соединению уже не важен
    if (reason !== 'io client disconnect' && !stopped) {
      cancelRetry();
      showOverlay('Связь потеряна. Переподключаемся…');
    }
  });

  // Телефон ведущего проснулся или вкладка снова на экране — не ждём следующей попытки Socket.IO.
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible' || stopped) return;
    keepScreenOn();
    if (!socket.connected) reconnectNow();
  });
  window.addEventListener('online', () => {
    if (!socket.connected && !stopped) reconnectNow();
  });

  socket.on('room:closed', ({ message, reason }) => {
    // Комнату закрыла блокировка ведущего: следом придёт access:banned с причиной и сроком.
    if (closingOnPurpose || reason === 'host-banned') return;
    stop();
    if (reason === 'replaced') {
      socket.disconnect();
      showOverlay(message, { error: true });
      return;
    }
    goHome(message, 'error');
  });

  socket.on('error', ({ message }) => console.warn('[server]', message));
  return socket;
}

/** Закрывает комнату по воле ведущего (игроки получат уведомление). */
export async function closeRoom(socket) {
  closingOnPurpose = true;
  stop();
  try {
    await request(socket, 'host:close', {}, 4_000);
  } catch {
    /* комната и так закроется, когда ведущий уйдёт */
  }
  hostSession.clear();
  socket.disconnect();
}
