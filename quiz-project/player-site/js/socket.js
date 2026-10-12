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
      reject(Object.assign(new Error('Не удалось связаться с сервером игры. Проверьте интернет.'), { code: 'DISCONNECTED' }));
    };
    document.head.append(script);
  });
  return clientLoader;
}

export async function connectPlayer() {
  const io = await loadClient();
  return io(SERVER_URL, {
    transports: ['websocket', 'polling'],
    // Если WebSocket в сети заблокирован (некоторые Wi-Fi и прокси), пробуем long-polling.
    tryAllTransports: true,
    reconnectionDelay: 800,
    reconnectionDelayMax: 3000,
    // Разброс пауз: после сбоя Wi-Fi весь зал не ломится на сервер в одну и ту же миллисекунду.
    randomizationFactor: 0.5,
  });
}

const failure = (message, code) => Object.assign(new Error(message), { code });

/**
 * Отправляет событие и ждёт ответа. Бросает Error с полем code, если сервер вернул ошибку.
 * Коды клиента: DISCONNECTED — соединения нет или оно оборвалось (запрос не ушёл или ответ потерян),
 * TIMEOUT — соединение есть, но сервер не ответил за timeoutMs.
 * Без соединения запрос не ставится в очередь: иначе Socket.IO отправит его после переподключения,
 * раньше, чем игрок вернётся в комнату.
 */
export function request(socket, event, payload = {}, { timeoutMs = 8000 } = {}) {
  return new Promise((resolve, reject) => {
    if (!socket?.connected) {
      reject(failure('Нет связи с сервером. Подождите секунду — переподключаемся.', 'DISCONNECTED'));
      return;
    }
    socket.timeout(timeoutMs).emit(event, payload, (error, response) => {
      if (error) {
        reject(socket.connected
          ? failure('Сервер не ответил. Проверьте соединение.', 'TIMEOUT')
          : failure('Связь прервалась. Переподключаемся…', 'DISCONNECTED'));
        return;
      }
      if (!response?.ok) {
        reject(failure(response?.error || 'Ошибка сервера', response?.code || 'UNKNOWN'));
        return;
      }
      resolve(response);
    });
  });
}
