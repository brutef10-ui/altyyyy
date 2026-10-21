// /api/admin/* — только для администратора: 401 без входа, 403 для остальных аккаунтов.
// Роль проверяется на сервере на каждом запросе (из сессии в БД), а не по данным клиента.
// Каждое изменяющее действие записывается в журнал аудита вместе с самим изменением (одна транзакция).
import express from 'express';
import { forwardedChain } from '../identity/clientIp.js';
import { RULES } from '../security/throttle.js';

export function adminRouter({ db, identity, audit, config }) {
  const router = express.Router();
  router.use(express.json({ limit: '16kb' }), identity.requireAdmin, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  // Лимит изменяющих действий одного администратора.
  async function adminOps(req, res, next) {
    try {
      const key = `admin:ops:${req.identity.account.id}`;
      await identity.throttle.check(key);
      await identity.throttle.hit(key, RULES.adminOps);
      next();
    } catch (error) {
      next(error);
    }
  }
  const mutating = [identity.csrf, adminOps];

  const auditMeta = (req) => ({ admin: req.identity.account, ip: req.identity.ip, userAgent: req.identity.userAgent });

  // Одноразовый код восстановления для пользователя. Код возвращается один раз и нигде не сохраняется в открытом виде.
  router.post('/accounts/:id/recovery-code', ...mutating, async (req, res) => {
    const issued = await db.tx(async (tx) => {
      const result = await identity.recovery.issueAdminCode(req.params.id, req.identity.account.id, tx);
      await audit.record({
        ...auditMeta(req),
        action: 'recovery_code.issue',
        targetType: 'account',
        targetId: req.params.id,
        details: { login: result.login, expiresAt: result.expiresAt, revokedPrevious: result.revoked },
      }, tx);
      return result;
    });
    res.status(201).json({ code: issued.code, expiresAt: issued.expiresAt, login: issued.login, ttlMinutes: config.recoveryCodeTtlMinutes });
  });

  // Диагностика IP за прокси: как сервер видит адрес клиента. Нужна, чтобы выставить TRUST_PROXY_HOPS
  // на реальном деплое (docs/ACCOUNTS_PLAN.md, раздел 4).
  router.get('/diagnostics/ip', (req, res) => {
    const pick = (name) => req.get(name) ?? null;
    res.json({
      computedIp: req.identity.ip,
      mode: config.clientIpMode,
      trustProxyHops: config.trustProxyHops,
      clientIpHeader: config.clientIpHeader || null,
      remoteAddress: req.socket.remoteAddress,
      xForwardedFor: forwardedChain(req.headers),
      headers: {
        'x-forwarded-for': pick('x-forwarded-for'),
        'x-forwarded-proto': pick('x-forwarded-proto'),
        'x-real-ip': pick('x-real-ip'),
        'cf-connecting-ip': pick('cf-connecting-ip'),
        'true-client-ip': pick('true-client-ip'),
        'cf-ipcountry': pick('cf-ipcountry'),
      },
      expressIp: req.ip,
      secure: req.secure,
    });
  });

  return router;
}
