// Подключение ведущего к серверу через Socket.IO.
//
// Лобби, игра и итоги — разные страницы, поэтому при каждом переходе соединение создаётся заново.
// Новая страница «возвращает» себе комнату событием host:resume с секретным ключом комнаты,
// а сервер ждёт ведущего несколько секунд, прежде чем закрыть комнату.
import { SERVER_URL } from './config.js';
import { getHostToken } from './api.js';
import { flash, hostSession, launchRequest } from './session.js';
import { hideOverlay, showOverlay } from './ui.js';

const STATE_PAGES = {
  lobby: 'lobby.html',
  question: 'game.html',
  results: 'game.html',
  final: 'results.html',
};

const FATAL_CODES = new Set(['ROOM_NOT_FOUND', 'NO_ROOM', 'INVALID_QUIZ', 'NOT_FOUND', 'UNAUTHORIZED', 'BAD_CODE']);

let clientLoader = null;
let closingOnPurpose = false;

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

/** Отправляет событие и ждёт ответа сервера. Бросает Error с полем code, если сервер вернул ошибку. */
export async function request(socket, event, payload = {}, timeoutMs = 10_000) {
  let response;
  try {
    response = await socket.timeout(timeoutMs).emitWithAck(event, payload);
  } catch {
    throw Object.assign(new Error('Сервер не ответил. Проверьте соединение.'), { code: 'TIMEOUT' });
  }
  if (!response?.ok) {
    throw Object.assign(new Error(response?.error || 'Ошибка сервера'), { code: response?.code || 'UNKNOWN' });
  }
  return response;
}

export function pageForState(state) {
  return STATE_PAGES[state] || 'index.html';
}

export function goHome(message, type = 'info') {
  if (message) flash.set(message, type);
  hostSession.clear();
  location.href = 'index.html';
}

/** Запуск игры: лобби создаст новую комнату с новым кодом. */
export function launchGame({ quizId = null, quiz = null }) {
  launchRequest.set({ quizId, quiz });
  hostSession.clear();
  location.href = 'lobby.html';
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

/**
 * Подключает страницу ведущего к комнате.
 * @param {object} options
 * @param {string} options.page — имя текущей страницы (lobby.html, game.html, results.html)
 * @param {boolean} [options.allowCreate] — создать комнату, если её ещё нет (только лобби)
 * @param {(snapshot: object, session: object) => void} options.onReady — после каждого (пере)подключения
 */
export async function openHostRoom({ page, allowCreate = false, onReady }) {
  showOverlay('Подключение к серверу…');
  let io;
  try {
    io = await loadClient();
  } catch (error) {
    showOverlay(`${error.message} Проверьте, что сервер запущен.`, { error: true, retry: true });
    throw error;
  }

  const socket = io(SERVER_URL, {
    auth: { token: getHostToken() },
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 3000,
  });

  socket.on('connect', async () => {
    try {
      const { snapshot, session } = await attach(socket, allowCreate);
      const target = pageForState(snapshot.state);
      if (target !== page) {
        location.replace(target);
        return;
      }
      hideOverlay();
      onReady(snapshot, session);
    } catch (error) {
      if (FATAL_CODES.has(error.code)) goHome(error.message, 'error');
      else showOverlay(error.message, { error: true, retry: true });
    }
  });

  socket.on('connect_error', () => showOverlay('Нет связи с сервером. Пробуем переподключиться…'));
  socket.on('disconnect', (reason) => {
    if (reason !== 'io client disconnect') showOverlay('Связь потеряна. Переподключаемся…');
  });

  socket.on('room:closed', ({ message, reason }) => {
    if (closingOnPurpose) return;
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
  try {
    await request(socket, 'host:close', {}, 4_000);
  } catch {
    /* комната и так закроется, когда ведущий уйдёт */
  }
  hostSession.clear();
  socket.disconnect();
}
