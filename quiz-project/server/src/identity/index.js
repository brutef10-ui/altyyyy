// Единая личность запроса: IP → посетитель (cookie vid) → сессия (cookie sid) → аккаунт.
// Одинаково для HTTP (req.identity) и Socket.IO (socket.identity).
// Роль и владелец берутся только отсюда, т. е. из БД на сервере, — никогда из данных клиента.
import { createHmac, randomBytes } from 'node:crypto';
import { AppError } from '../errors.js';
import { Throttle } from '../security/throttle.js';
import { AccountService } from './accounts.js';
import { ipFromRequest, ipFromSocket } from './clientIp.js';
import { cookieNames, cookieOptions, readCookies } from './cookies.js';
import { RecoveryService } from './recovery.js';
import { SessionService } from './sessions.js';
import { safeEqual } from './tokens.js';
import { VISITOR_COOKIE_MAX_AGE_MS, VisitorService } from './visitors.js';

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

export const unauthorized = () => new AppError('Войдите в аккаунт, чтобы продолжить.', { status: 401, code: 'UNAUTHORIZED' });

function sessionSecret(config) {
  if (config.sessionSecret && config.sessionSecret.length >= 32) return config.sessionSecret;
  if (config.production) throw new Error('SESSION_SECRET не задан или короче 32 символов (см. .env.example).');
  if (config.sessionSecret) console.warn('[auth] SESSION_SECRET короче 32 символов — используем случайный на время работы процесса.');
  return randomBytes(32).toString('hex');
}

export function createIdentity({ db, config }) {
  const names = cookieNames(config);
  const secret = sessionSecret(config);
  const visitors = new VisitorService(db);
  const sessions = new SessionService(db, { idleDays: config.sessionIdleDays, absoluteDays: config.sessionAbsoluteDays });
  const accounts = new AccountService(db, { adminLogin: config.adminLogin });
  const throttle = new Throttle(db);
  const recovery = new RecoveryService(db, { accounts, sessions, codeTtlMinutes: config.recoveryCodeTtlMinutes });

  // CSRF-токен привязан к посетителю: его знает только страница, которой сервер его выдал.
  const csrfToken = (visitorId) => createHmac('sha256', secret).update(`csrf:${visitorId}`).digest('base64url');

  function setSessionCookie(res, token) {
    res.cookie(names.session, token, cookieOptions(config, sessions.cookieMaxAgeMs));
  }

  function clearSessionCookie(res) {
    res.clearCookie(names.session, { ...cookieOptions(config, 0), maxAge: undefined });
  }

  // Сайт ведущего и игрока, а также страницы, которые отдаёт сам сервер (SERVE_SITES).
  function isAllowedOrigin(origin, host) {
    if (config.allOrigins.includes(origin)) return true;
    try {
      return new URL(origin).host === host;
    } catch {
      return false;
    }
  }

  /**
   * Express-middleware: определяет посетителя и сессию. Ничего не запрещает — только заполняет req.identity.
   * Посетитель создаётся только для страниц сайта и API (не для картинок, стилей и скриптов).
   */
  function http({ createVisitor = (req) => req.method === 'GET' } = {}) {
    return async (req, res, next) => {
      try {
        const ip = ipFromRequest(req, config);
        const userAgent = req.get('user-agent') || null;
        const cookies = readCookies(req.headers.cookie);
        const meta = { ip, userAgent };

        let visitor = await visitors.find(cookies[names.visitor], meta);
        if (visitor?.touched) res.cookie(names.visitor, cookies[names.visitor], cookieOptions(config, VISITOR_COOKIE_MAX_AGE_MS));
        if (!visitor && createVisitor(req)) {
          visitor = await visitors.create(meta);
          if (visitor) res.cookie(names.visitor, visitor.token, cookieOptions(config, VISITOR_COOKIE_MAX_AGE_MS));
        }

        const sessionToken = cookies[names.session];
        const session = sessionToken ? await sessions.resolve(sessionToken, meta) : null;
        if (sessionToken && !session) clearSessionCookie(res);

        req.identity = {
          ip,
          userAgent,
          visitorId: visitor?.id ?? null,
          session,
          account: session?.account ?? null,
        };
        next();
      } catch (error) {
        next(error);
      }
    };
  }

  /** Только для вошедших. req.owner — для существующего кода игр (владелец = аккаунт). */
  function requireAccount(req, res, next) {
    const account = req.identity?.account;
    if (!account) {
      next(unauthorized());
      return;
    }
    req.owner = { id: account.id, kind: 'account' };
    next();
  }

  function requireAdmin(req, res, next) {
    const account = req.identity?.account;
    if (!account) next(unauthorized());
    else if (account.role !== 'admin') next(new AppError('Недостаточно прав', { status: 403, code: 'FORBIDDEN' }));
    else next();
  }

  /**
   * CSRF для изменяющих запросов: Origin должен быть нашим сайтом, а заголовок X-CSRF-Token —
   * совпадать с токеном посетителя (его выдаёт GET /api/auth/session). Плюс SameSite=Lax у cookie.
   */
  function csrf(req, res, next) {
    if (SAFE_METHODS.has(req.method)) {
      next();
      return;
    }
    const origin = req.get('origin');
    const fetchSite = req.get('sec-fetch-site');
    const badOrigin = origin ? !isAllowedOrigin(origin, req.get('host')) : fetchSite === 'cross-site';
    const visitorId = req.identity?.visitorId;
    const token = req.get('x-csrf-token');
    if (badOrigin || !visitorId || !token || !safeEqual(token, csrfToken(visitorId))) {
      next(new AppError('Сессия страницы устарела. Обновите страницу.', { status: 403, code: 'CSRF' }));
      return;
    }
    next();
  }

  /** Личность подключения Socket.IO по cookie из handshake. Посетителя не создаёт. */
  async function fromHandshake(socket) {
    const ip = ipFromSocket(socket, config);
    const userAgent = socket.handshake.headers['user-agent'] || null;
    const cookies = readCookies(socket.handshake.headers.cookie);
    const meta = { ip, userAgent };
    const visitor = await visitors.find(cookies[names.visitor], meta);
    const sessionToken = cookies[names.session] || null;
    const session = sessionToken ? await sessions.resolve(sessionToken, meta) : null;
    return {
      ip,
      userAgent,
      visitorId: visitor?.id ?? null,
      session,
      account: session?.account ?? null,
      sessionToken: session ? sessionToken : null,
    };
  }

  /** Перепроверить сессию подключения (её могли отозвать: выход, смена пароля, блокировка). */
  async function refresh(identity) {
    if (!identity?.sessionToken) return identity;
    const session = await sessions.resolve(identity.sessionToken, { ip: identity.ip, userAgent: identity.userAgent });
    identity.session = session;
    identity.account = session?.account ?? null;
    if (!session) identity.sessionToken = null;
    return identity;
  }

  return {
    names,
    visitors,
    sessions,
    accounts,
    throttle,
    recovery,
    csrfToken,
    setSessionCookie,
    clearSessionCookie,
    http,
    requireAccount,
    requireAdmin,
    csrf,
    fromHandshake,
    refresh,
    stop() {
      visitors.stop();
    },
  };
}
