// /api/admin/* — только для администратора: 401 без входа, 403 для остальных аккаунтов.
// Роль проверяется на сервере на каждом запросе (из сессии в БД), а не по данным клиента.
// Каждое изменяющее действие записывается в журнал аудита вместе с самим изменением (одна транзакция).
import express from 'express';
import { AppError, notFound } from '../errors.js';
import { forwardedChain } from '../identity/clientIp.js';
import { RULES } from '../security/throttle.js';
import { MIN_PREFIX, isUuid, parseIpTarget } from '../security/bans.js';
import { AdminQueries } from './queries.js';

const MAX_BAN_MINUTES = 10 * 365 * 24 * 60;
const invalid = (message) => new AppError(message, { status: 422, code: 'INVALID' });

/** Проверка запроса на блокировку: цель (аккаунт / устройство / IP), причина, срок. */
async function checkBanInput(db, input) {
  const reason = typeof input.reason === 'string' ? input.reason.trim().replace(/\s+/g, ' ') : '';
  if (reason.length < 3 || reason.length > 500) throw invalid('Причина блокировки: от 3 до 500 символов.');

  let endsAt = null;
  if (input.forever !== true) {
    const minutes = Number(input.durationMinutes);
    if (!Number.isInteger(minutes) || minutes < 1 || minutes > MAX_BAN_MINUTES) throw invalid('Срок блокировки: от 1 минуты до 10 лет или навсегда.');
    endsAt = minutes;
  }

  const target = { accountId: null, visitorId: null, ip: null };
  if (input.accountId !== undefined && input.accountId !== null && input.accountId !== '') {
    if (!isUuid(input.accountId)) throw notFound('Аккаунт не найден');
    const account = await db.one('SELECT id, role FROM accounts WHERE id = $1', [input.accountId]);
    if (!account) throw notFound('Аккаунт не найден');
    if (account.role === 'admin') throw new AppError('Аккаунт администратора заблокировать нельзя.', { status: 409, code: 'ADMIN_MANAGED' });
    target.accountId = account.id;
  }
  if (input.visitorId !== undefined && input.visitorId !== null && input.visitorId !== '') {
    if (!isUuid(input.visitorId) || !(await db.one('SELECT 1 FROM visitors WHERE id = $1', [input.visitorId]))) throw notFound('Посетитель не найден');
    target.visitorId = input.visitorId;
  }
  if (input.ip !== undefined && input.ip !== null && input.ip !== '') {
    const ip = parseIpTarget(input.ip);
    if (!ip) throw invalid('IP: адрес вида 203.0.113.7 или подсеть вида 203.0.113.0/24.');
    // За одним IP часто сидит целая Wi-Fi сеть; широкие подсети заблокировали бы непричастных.
    if (ip.prefix < MIN_PREFIX[ip.family]) throw invalid(`Слишком широкая подсеть: не шире /${MIN_PREFIX[ip.family]}.`);
    target.ip = ip.full ? ip.address : `${ip.address}/${ip.prefix}`;
  }
  if (!target.accountId && !target.visitorId && !target.ip) throw invalid('Укажите, кого блокировать: аккаунт, устройство или IP.');
  return { reason, durationMinutes: endsAt, ...target };
}

const BAN_COLUMNS = `b.id, b.account_id, a.login AS account_login, b.visitor_id, b.ip::text AS ip, b.reason,
  b.starts_at, b.ends_at, b.created_at, b.created_by_login, b.lifted_at, b.lifted_by_login, b.lift_reason,
  (b.lifted_at IS NULL AND b.starts_at <= now() AND (b.ends_at IS NULL OR b.ends_at > now())) AS active`;

function banView(row) {
  return {
    id: row.id,
    accountId: row.account_id,
    accountLogin: row.account_login,
    visitorId: row.visitor_id,
    ip: row.ip ? row.ip.replace(/\/(32|128)$/, '') : null,
    reason: row.reason,
    startsAt: row.starts_at,
    endsAt: row.ends_at,
    forever: row.ends_at === null,
    createdAt: row.created_at,
    createdBy: row.created_by_login,
    liftedAt: row.lifted_at,
    liftedBy: row.lifted_by_login,
    liftReason: row.lift_reason,
    status: row.lifted_at ? 'lifted' : row.active ? 'active' : 'expired',
  };
}

export function adminRouter({ db, identity, audit, config, sharing }) {
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
  const queries = new AdminQueries(db);

  // ---------- Чтение: списки, карточки, журналы ----------

  router.get('/overview', async (req, res) => {
    res.json(await queries.overview());
  });
  // Подсказки о шаринге добавляются к строкам, только если администратор их включил.
  async function withSharing(items) {
    const analysis = await sharing.analysis();
    if (!analysis) return { items, sharing: null };
    const hidden = await sharing.hiddenIds();
    return {
      items: items.map((item) => {
        const result = analysis.results.get(item.id);
        return { ...item, sharing: result ? { ...result, hidden: hidden.has(item.id) } : null };
      }),
      sharing: { computedAt: analysis.computedAt, analyzed: analysis.analyzed, limited: analysis.limited, durationMs: analysis.durationMs },
    };
  }

  router.get('/accounts', async (req, res) => {
    // Фильтр «Подозрительные»: жёлтые и красные, кроме скрытых, по убыванию оценки.
    if (req.query.suspicious === '1') {
      const analysis = await sharing.analysis();
      if (!analysis) throw new AppError('Подсказки о шаринге выключены', { status: 409, code: 'SHARING_DISABLED' });
      const hidden = await sharing.hiddenIds();
      const ids = [...analysis.results.entries()]
        .filter(([id, result]) => result.level !== 'green' && !hidden.has(id))
        .sort((a, b) => b[1].score - a[1].score)
        .map(([id]) => id);
      const page = await queries.accounts(req.query, { ids });
      res.json({ ...page, ...(await withSharing(page.items)) });
      return;
    }
    const page = await queries.accounts(req.query);
    res.json({ ...page, ...(await withSharing(page.items)) });
  });
  router.get('/visitors', async (req, res) => {
    res.json(await queries.visitors(req.query));
  });
  // Открытие карточки (IP, устройства, история) — доступ к персональным данным, поэтому пишется в аудит.
  router.get('/accounts/:id', async (req, res) => {
    const card = await queries.account(req.params.id);
    await audit.record({ ...auditMeta(req), action: 'account.view', targetType: 'account', targetId: card.account.id, details: { login: card.account.login } });
    const [withHints] = (await withSharing([card.account])).items;
    res.json({ ...card, sharing: withHints.sharing ?? null, sharingEnabled: await sharing.enabled() });
  });

  // ---------- Подсказки о шаринге (только показ; сервер по ним ничего не делает) ----------

  router.get('/settings', async (req, res) => {
    res.json({ sharingHints: await sharing.enabled() });
  });

  router.post('/settings/sharing', ...mutating, async (req, res) => {
    const enabled = req.body?.enabled === true;
    await db.tx(async (tx) => {
      await sharing.setEnabled(enabled, req.identity.account, tx);
      await audit.record({ ...auditMeta(req), action: 'settings.update', targetType: 'setting', targetId: 'sharing_hints', details: { key: 'sharing_hints', value: enabled } }, tx);
    });
    res.json({ sharingHints: enabled });
  });

  // Пересчитать сейчас (иначе результат живёт несколько минут).
  router.post('/sharing/recompute', ...mutating, async (req, res) => {
    const analysis = await sharing.analysis({ force: true });
    if (!analysis) throw new AppError('Подсказки о шаринге выключены', { status: 409, code: 'SHARING_DISABLED' });
    const flagged = [...analysis.results.values()].filter((result) => result.level !== 'green').length;
    res.json({ computedAt: analysis.computedAt, analyzed: analysis.analyzed, flagged, limited: analysis.limited, durationMs: analysis.durationMs });
  });

  router.post('/accounts/:id/sharing-hidden', ...mutating, async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Аккаунт не найден');
    const account = await db.one('SELECT id, login FROM accounts WHERE id = $1', [req.params.id]);
    if (!account) throw notFound('Аккаунт не найден');
    const hidden = req.body?.hidden === true;
    await db.tx(async (tx) => {
      await sharing.setHidden(account.id, hidden, req.identity.account, tx);
      await audit.record({ ...auditMeta(req), action: hidden ? 'sharing.hide' : 'sharing.unhide', targetType: 'account', targetId: account.id, details: { login: account.login } }, tx);
    });
    res.json({ hidden });
  });
  router.get('/visitors/:id', async (req, res) => {
    const card = await queries.visitor(req.params.id);
    await audit.record({ ...auditMeta(req), action: 'visitor.view', targetType: 'visitor', targetId: card.visitor.id });
    res.json(card);
  });
  router.get('/events', async (req, res) => {
    res.json(await queries.events(req.query));
  });
  router.get('/audit', async (req, res) => {
    res.json(await queries.audit(req.query));
  });

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

  // ---------- Блокировки ----------

  // Список: status=active — действующие, status=all — вся история (снятые и истёкшие тоже).
  router.get('/bans', async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number.parseInt(req.query.limit, 10) || 50));
    const offset = Math.max(0, Number.parseInt(req.query.offset, 10) || 0);
    const activeOnly = req.query.status !== 'all';
    const where = activeOnly ? 'WHERE b.lifted_at IS NULL AND (b.ends_at IS NULL OR b.ends_at > now())' : '';
    const rows = await db.many(
      `SELECT ${BAN_COLUMNS} FROM bans b LEFT JOIN accounts a ON a.id = b.account_id ${where}
        ORDER BY b.created_at DESC LIMIT $1 OFFSET $2`,
      [limit + 1, offset],
    );
    res.json({ bans: rows.slice(0, limit).map(banView), hasMore: rows.length > limit });
  });

  router.post('/bans', ...mutating, async (req, res) => {
    const input = await checkBanInput(db, req.body ?? {});
    const admin = req.identity.account;
    const row = await db.tx(async (tx) => {
      const created = await tx.one(
        `INSERT INTO bans (account_id, visitor_id, ip, reason, ends_at, created_by, created_by_login)
         VALUES ($1, $2, $3, $4, CASE WHEN $5::int IS NULL THEN NULL ELSE now() + make_interval(mins => $5::int) END, $6, $7)
         RETURNING id`,
        [input.accountId, input.visitorId, input.ip, input.reason, input.durationMinutes, admin.id, admin.login],
      );
      await audit.record({
        ...auditMeta(req),
        action: 'ban.create',
        targetType: input.accountId ? 'account' : input.visitorId ? 'visitor' : 'ip',
        targetId: input.accountId ?? input.visitorId ?? input.ip,
        details: { banId: created.id, accountId: input.accountId, visitorId: input.visitorId, ip: input.ip, reason: input.reason, durationMinutes: input.durationMinutes, forever: input.durationMinutes === null },
      }, tx);
      return tx.one(`SELECT ${BAN_COLUMNS} FROM bans b LEFT JOIN accounts a ON a.id = b.account_id WHERE b.id = $1`, [created.id]);
    });
    await identity.bans.changed();
    res.status(201).json({ ban: banView(row) });
  });

  // Снять блокировку. Запись остаётся в истории.
  router.post('/bans/:id/lift', ...mutating, async (req, res) => {
    if (!isUuid(req.params.id)) throw notFound('Блокировка не найдена');
    const reason = typeof req.body?.reason === 'string' ? req.body.reason.trim().slice(0, 500) : '';
    const admin = req.identity.account;
    const row = await db.tx(async (tx) => {
      const lifted = await tx.one(
        `UPDATE bans SET lifted_at = now(), lifted_by = $2, lifted_by_login = $3, lift_reason = $4
          WHERE id = $1 AND lifted_at IS NULL RETURNING id, account_id, visitor_id, ip::text AS ip`,
        [req.params.id, admin.id, admin.login, reason || null],
      );
      if (!lifted) throw notFound('Блокировка не найдена или уже снята');
      await audit.record({
        ...auditMeta(req),
        action: 'ban.lift',
        targetType: lifted.account_id ? 'account' : lifted.visitor_id ? 'visitor' : 'ip',
        targetId: lifted.account_id ?? lifted.visitor_id ?? lifted.ip,
        details: { banId: lifted.id, reason: reason || null },
      }, tx);
      return tx.one(`SELECT ${BAN_COLUMNS} FROM bans b LEFT JOIN accounts a ON a.id = b.account_id WHERE b.id = $1`, [lifted.id]);
    });
    await identity.bans.changed();
    res.json({ ban: banView(row) });
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
