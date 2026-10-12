// Определение владельца игр.
//
// Сейчас аккаунтов нет: браузер ведущего хранит секретный токен в localStorage
// и присылает его в заголовке Authorization (REST) или в socket.handshake.auth (Socket.IO).
// На сервере хранится только SHA-256 от токена, поэтому утечка quizzes.json не раскрывает токены.
//
// Как добавить логин позже: допишите ещё один «резолвер» (например, по cookie-сессии или JWT),
// который возвращает { id: 'user:<id>', kind: 'user' }, и поставьте его первым в RESOLVERS.
// Остальной код работает только с owner.id и ничего не знает о способе входа.
// Чтобы перенести игры с устройства в аккаунт, достаточно заменить ownerId 'device:…' на 'user:…'.
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

const DEVICE_TOKEN = /^[a-f0-9]{64}$/;

function ownerFromDeviceToken(token) {
  if (typeof token !== 'string' || !DEVICE_TOKEN.test(token)) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  return { id: `device:${hash}`, kind: 'device' };
}

function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header || '');
  return match ? match[1] : null;
}

const RESOLVERS = [
  (credentials) => ownerFromDeviceToken(credentials.token),
];

export function resolveOwner(credentials) {
  for (const resolve of RESOLVERS) {
    const owner = resolve(credentials);
    if (owner) return owner;
  }
  return null;
}

export function ownerFromRequest(req) {
  return resolveOwner({ token: bearerToken(req.get('authorization')) });
}

export function ownerFromSocket(socket) {
  return resolveOwner({ token: socket.handshake.auth?.token });
}

// Express-middleware: пропускает дальше только запросы с известным владельцем.
export function requireOwner(req, res, next) {
  const owner = ownerFromRequest(req);
  if (!owner) {
    next(new AppError('Не удалось определить ведущего. Обновите страницу.', { status: 401, code: 'UNAUTHORIZED' }));
    return;
  }
  req.owner = owner;
  next();
}
