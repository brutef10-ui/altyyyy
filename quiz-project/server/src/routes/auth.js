// /api/auth/* — вход, регистрация, выход, смена пароля, резервный код.
// Пароли и коды не пишутся в логи и не возвращаются в ответах (кроме однократного показа нового
// резервного кода его владельцу). Ошибки входа одинаковые для неизвестного логина и неверного пароля.
import express from 'express';
import { AppError } from '../errors.js';
import { normalizeLogin } from '../identity/accounts.js';
import { unauthorized } from '../identity/index.js';
import { RULES, throttled } from '../security/throttle.js';
import { bannedError, publicBan } from '../security/bans.js';
import { EVENT_TYPES } from '../logs/events.js';

const HOUR = 60 * 60;

export function authRouter({ identity, config, events, audit = null }) {
  const { accounts, sessions, throttle } = identity;
  const router = express.Router();
  router.use(express.json({ limit: '4kb' }), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  const registerRules = {
    attemptsIp: { max: Math.max(30, config.registrationsPerIpPerHour * 3), windowSec: HOUR, blockSec: HOUR },
    ip: { max: config.registrationsPerIpPerHour, windowSec: HOUR, blockSec: HOUR },
    global: { max: config.registrationsPerHour, windowSec: HOUR, blockSec: 15 * 60 },
  };

  // Новая сессия после входа или регистрации: старая (если была) отзывается — защита от фиксации сессии.
  async function startSession(req, res, account) {
    const { identity: who } = req;
    if (who.session) await sessions.revoke(who.session.id, 'rotated');
    const session = await sessions.create(account.id, { visitorId: who.visitorId, ip: who.ip, userAgent: who.userAgent });
    if (who.visitorId) await identity.visitors.linkAccount(who.visitorId, account.id);
    await accounts.markLogin(account.id);
    identity.setSessionCookie(res, session.token);
    return session;
  }

  // Куда вести после входа решает сервер по роли из базы: администратора — сразу в админ-консоль.
  // У администратора своя учётная запись только для консоли; игры ведущий создаёт под обычным аккаунтом.
  const homeFor = (account) => (account?.role === 'admin' ? '/admin/' : null);

  const body = (req) => (req.body && typeof req.body === 'object' && !Array.isArray(req.body) ? req.body : {});

  // Текущее состояние: кто вошёл, CSRF-токен для изменяющих запросов и действующая блокировка (если есть).
  router.get('/session', (req, res) => {
    const { account, visitorId, ban } = req.identity;
    res.json({
      account: account ? { id: account.id, login: account.login, role: account.role } : null,
      home: homeFor(account),
      csrfToken: visitorId ? identity.csrfToken(visitorId) : null,
      adminContact: config.adminContact || null,
      ban: publicBan(ban),
    });
  });

  // Блокировка аккаунта, найденного по логину и паролю (устройство и IP проверены до входа).
  const accountBan = (req, account) => identity.bans.find({ account, visitorId: req.identity.visitorId, ip: req.identity.ip });

  router.post('/register', identity.csrf, identity.rejectBanned, async (req, res) => {
    const input = body(req);
    // Поле-ловушка: человек его не видит и не заполняет.
    if (input.website) throw new AppError('Не удалось зарегистрироваться. Обновите страницу.', { code: 'REJECTED' });
    const { ip, visitorId } = req.identity;
    const ipKey = `register:ip:${ip}`;
    const visitorKey = `register:visitor:${visitorId}`;
    await throttle.check(`register:attempts:${ip}`, ipKey, visitorKey, 'register:global');
    await throttle.hit(`register:attempts:${ip}`, registerRules.attemptsIp);

    const { account, backupCode } = await accounts.register({ login: input.login, password: input.password });
    await Promise.all([
      throttle.hit(ipKey, registerRules.ip),
      throttle.hit(visitorKey, RULES.registerVisitor),
      throttle.hit('register:global', registerRules.global),
    ]);
    await startSession(req, res, account);
    events?.record(EVENT_TYPES.register, req.identity, { account });
    res.status(201).json({ account, backupCode });
  });

  router.post('/login', identity.csrf, identity.rejectBanned, async (req, res) => {
    const input = body(req);
    const { ip } = req.identity;
    const login = normalizeLogin(input.login).slice(0, 64);
    const keys = { ip: `login:ip:${ip}`, account: `login:acct:${login}`, pair: `login:acct-ip:${login}|${ip}` };
    await throttle.check(keys.ip, keys.pair, keys.account);
    const failedAttempt = async () => {
      const blocked = await Promise.all([
        throttle.hit(keys.ip, RULES.loginIp),
        throttle.hit(keys.pair, RULES.loginAccountIp),
        throttle.hit(keys.account, RULES.loginAccount),
      ]);
      if (blocked.some(Boolean)) throw throttled(RULES.loginAccountIp.blockSec);
    };
    let account;
    try {
      account = await accounts.authenticate(input.login, input.password);
    } catch (error) {
      if (error.code === 'BAD_CREDENTIALS') await failedAttempt();
      throw error;
    }
    // Администратор — только с доверенного устройства. С чужого устройства ответ такой же, как при
    // неверном пароле (не подсказываем, что пароль подошёл), а попытка видна в журнале аудита.
    if (account.role === 'admin') {
      const who = { visitorId: req.identity.visitorId, ip, userAgent: req.identity.userAgent };
      const device = await identity.adminDevices.admit(account, who);
      const meta = { admin: account, targetType: 'visitor', targetId: who.visitorId, ip, userAgent: who.userAgent };
      if (!device.ok) {
        await audit?.record({ ...meta, action: 'admin.device.denied' });
        await failedAttempt();
        throw new AppError('Неверный логин или пароль', { status: 401, code: 'BAD_CREDENTIALS' });
      }
      if (device.added) await audit?.record({ ...meta, action: 'admin.device.added' });
    }
    await throttle.reset(keys.pair);
    const ban = accountBan(req, account);
    if (ban) throw bannedError(ban, config.adminContact);
    await startSession(req, res, account);
    events?.record(EVENT_TYPES.login, req.identity, { account });
    res.json({ account, home: homeFor(account) });
  });

  router.post('/logout', identity.csrf, async (req, res) => {
    const { session } = req.identity;
    if (session) await sessions.revoke(session.id, 'logout');
    identity.clearSessionCookie(res);
    res.status(204).end();
  });

  // Смена пароля: нужен текущий пароль. Остальные сессии аккаунта отзываются, текущая — заменяется новой.
  router.post('/password', identity.csrf, identity.rejectBanned, async (req, res) => {
    const { account, session } = req.identity;
    if (!account) throw unauthorized();
    const key = `password:${account.id}`;
    await throttle.check(key);
    const input = body(req);
    try {
      await accounts.changePassword(account.id, input.currentPassword, input.newPassword);
    } catch (error) {
      if (error.code === 'BAD_PASSWORD' && error.status === 403) await throttle.hit(key, RULES.passwordChange);
      throw error;
    }
    await sessions.revokeAll(account.id, 'password-changed', { exceptId: session.id });
    await startSession(req, res, account);
    res.json({ ok: true });
  });

  // Выйти на всех устройствах (в том числе на этом).
  router.post('/logout-all', identity.csrf, async (req, res) => {
    const { account } = req.identity;
    if (!account) throw unauthorized();
    await sessions.revokeAll(account.id, 'logout-all');
    identity.clearSessionCookie(res);
    res.status(204).end();
  });

  // Восстановление доступа: логин + резервный код или одноразовый код от администратора + новый пароль.
  // Все сессии аккаунта отзываются, выдаётся новая сессия и новый резервный код (показывается один раз).
  router.post('/recover', identity.csrf, identity.rejectBanned, async (req, res) => {
    const input = body(req);
    const { ip } = req.identity;
    const login = normalizeLogin(input.login).slice(0, 64);
    const keys = { ip: `recover:ip:${ip}`, account: `recover:acct:${login}`, pair: `recover:acct-ip:${login}|${ip}` };
    await throttle.check(keys.ip, keys.pair, keys.account);
    let result;
    try {
      result = await identity.recovery.recover({ login: input.login, code: input.code, newPassword: input.newPassword });
    } catch (error) {
      if (error.code === 'BAD_RECOVERY') {
        const blocked = await Promise.all([
          throttle.hit(keys.ip, RULES.recoverIp),
          throttle.hit(keys.pair, RULES.recoverAccountIp),
          throttle.hit(keys.account, RULES.recoverAccount),
        ]);
        if (blocked.some(Boolean)) throw throttled(RULES.recoverAccountIp.blockSec);
      }
      throw error;
    }
    events?.record(EVENT_TYPES.recover, req.identity, { account: result.account, details: { method: result.method } });
    // Заблокированному аккаунту пароль сменить можно (и новый код он должен увидеть), а войти — нет.
    const ban = accountBan(req, result.account);
    if (ban) {
      res.json({ account: null, backupCode: result.backupCode, ban: { ...publicBan(ban), contact: config.adminContact || null } });
      return;
    }
    await startSession(req, res, result.account);
    res.json({ account: result.account, backupCode: result.backupCode });
  });

  // Новый резервный код (старый перестаёт действовать). Показывается один раз.
  router.post('/backup-code', identity.csrf, identity.rejectBanned, async (req, res) => {
    const { account } = req.identity;
    if (!account) throw unauthorized();
    const key = `password:${account.id}`;
    await throttle.check(key);
    try {
      const backupCode = await accounts.regenerateBackupCode(account.id, body(req).currentPassword);
      res.json({ backupCode });
    } catch (error) {
      if (error.code === 'BAD_PASSWORD' && error.status === 403) await throttle.hit(key, RULES.passwordChange);
      throw error;
    }
  });

  return router;
}
