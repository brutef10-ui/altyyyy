// Подключение игрока к серверу через Socket.IO.
import { SERVER_URL } from './config.js';

let clientLoader = null;

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
      reject(new Error('Не удалось подключиться к серверу игры. Проверьте интернет.'));
    };
    document.head.append(script);
  });
  return clientLoader;
}

export async function connectPlayer() {
  const io = await loadClient();
  return io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    reconnectionDelayMax: 3000,
  });
}

/** Отправляет событие и ждёт ответа. Бросает Error с полем code, если сервер вернул ошибку. */
export async function request(socket, event, payload = {}, timeoutMs = 8000) {
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
