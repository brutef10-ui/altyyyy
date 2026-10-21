// Определение владельца игр.
//
// Владелец — аккаунт создателя игр. Его определяет сервер по cookie сессии (src/identity):
// HTTP — req.identity.account, Socket.IO — socket.identity.account. Данные клиента
// (тело запроса, socket.handshake.auth) владельца и роль не задают.
//
// Остальной код работает только с owner.id (UUID аккаунта) и ничего не знает о способе входа.
//
// Токен устройства (до появления аккаунтов браузер ведущего хранил его в localStorage) больше
// не даёт доступа к играм: по нему только находятся старые игры этого браузера, чтобы перенести их
// в аккаунт (см. stores/legacy.js).
import { createHash } from 'node:crypto';
import { AppError } from './errors.js';

const DEVICE_TOKEN = /^[a-f0-9]{64}$/;

/** Старый владелец 'device:<sha256 токена>' — только для переноса игр в аккаунт. */
export function ownerFromDeviceToken(token) {
  if (typeof token !== 'string' || !DEVICE_TOKEN.test(token)) return null;
  const hash = createHash('sha256').update(token).digest('hex');
  return { id: `device:${hash}`, kind: 'device' };
}

export function bearerToken(header) {
  const match = /^Bearer\s+(\S+)$/i.exec(header || '');
  return match ? match[1] : null;
}

const RESOLVERS = [
  (credentials) => (credentials.account?.id ? { id: credentials.account.id, kind: 'account' } : null),
];

export function resolveOwner(credentials) {
  for (const resolve of RESOLVERS) {
    const owner = resolve(credentials);
    if (owner) return owner;
  }
  return null;
}

export function ownerFromRequest(req) {
  return resolveOwner({ account: req.identity?.account });
}

export function ownerFromSocket(socket) {
  return resolveOwner({ account: socket.identity?.account });
}

/** Владелец старых игр по токену устройства из заголовка Authorization. */
export function deviceOwnerFromRequest(req) {
  return ownerFromDeviceToken(bearerToken(req.get('authorization')));
}

// Express-middleware: пропускает дальше только запросы вошедшего создателя игр.
export function requireOwner(req, res, next) {
  const owner = ownerFromRequest(req);
  if (!owner) {
    next(new AppError('Войдите в аккаунт, чтобы продолжить.', { status: 401, code: 'UNAUTHORIZED' }));
    return;
  }
  req.owner = owner;
  next();
}
