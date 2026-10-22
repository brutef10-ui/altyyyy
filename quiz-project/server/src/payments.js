// Оплата доступа к созданию своих игр.
//
// Ведущий оплачивает услугу по QR-коду в приложении банка и прикрепляет чек. Сервер чек не проверяет:
// доступ открывается сразу, а администратор смотрит чеки в консоли и при подделке блокирует аккаунт.
// Чек хранится не дольше receiptRetentionHours (2 суток) и в резервные копии не попадает;
// факт оплаты (кто, когда, IP, браузер) хранится как журнал заходов.
//
// Право создавать, сохранять и запускать свои игры проверяется только здесь, на сервере.
import { AppError, notFound } from './errors.js';
import { parseUserAgent } from './logs/userAgent.js';
import { isUuid } from './security/bans.js';

export const RECEIPT_MAX_BYTES = 5 * 1024 * 1024;

// Тип файла — по содержимому, а не по заголовку запроса.
const RECEIPT_TYPES = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('latin1') === 'RIFF' && b.subarray(8, 12).toString('latin1') === 'WEBP',
  'application/pdf': (b) => b.subarray(0, 5).toString('latin1') === '%PDF-',
};
export const RECEIPT_CONTENT_TYPES = Object.freeze(Object.keys(RECEIPT_TYPES));

export const paymentRequired = () => new AppError('Создание своих игр — платная услуга. Оплатите доступ и прикрепите чек.', { status: 402, code: 'PAYMENT_REQUIRED' });

export class PaymentService {
  constructor(db, { required = true, amount = 100, currency = 'сом', receiptRetentionHours = 48 } = {}) {
    this.db = db;
    this.required = required;
    this.amount = amount;
    this.currency = currency;
    this.receiptRetentionHours = Math.min(48, receiptRetentionHours);
  }

  /** Может ли аккаунт создавать, сохранять и запускать свои игры. */
  canCreate(account) {
    if (!account || account.role === 'admin') return false;
    return !this.required || account.paid === true;
  }

  /** Для страницы ведущего: цена и есть ли доступ. */
  info(account) {
    return { required: this.required, amount: this.amount, currency: this.currency, canCreate: this.canCreate(account) };
  }

  /** Express: дальше — только если доступ оплачен. */
  requireAccess = (req, res, next) => {
    next(this.canCreate(req.identity?.account) ? undefined : paymentRequired());
  };

  /** Чек от ведущего: сохранить и сразу открыть доступ. */
  async submit(identity, buffer, contentType) {
    const account = identity.account;
    if (!account || account.role === 'admin') throw new AppError('Войдите в аккаунт ведущего.', { status: 403, code: 'FORBIDDEN' });
    if (account.paid) throw new AppError('Доступ уже оплачен.', { status: 409, code: 'ALREADY_PAID' });
    const type = String(contentType || '').split(';')[0].trim().toLowerCase();
    if (!Buffer.isBuffer(buffer) || buffer.length < 16 || !RECEIPT_TYPES[type]?.(buffer)) {
      throw new AppError('Чек — фото или скриншот (JPEG, PNG, WebP) или PDF.', { status: 415, code: 'BAD_RECEIPT' });
    }
    if (buffer.length > RECEIPT_MAX_BYTES) throw new AppError('Чек больше 5 МБ.', { status: 413, code: 'TOO_LARGE' });
    return this.db.tx(async (tx) => {
      const granted = await tx.one(
        'UPDATE accounts SET access_granted_at = now() WHERE id = $1 AND access_granted_at IS NULL RETURNING access_granted_at',
        [account.id],
      );
      if (!granted) throw new AppError('Доступ уже оплачен.', { status: 409, code: 'ALREADY_PAID' });
      const row = await tx.one(
        `INSERT INTO payments (account_id, visitor_id, ip, user_agent, amount, receipt_type, receipt_size, receipt)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8) RETURNING id, created_at`,
        [account.id, identity.visitorId ?? null, identity.ip ?? null, identity.userAgent?.slice(0, 400) ?? null, this.amount, type, buffer.length, buffer],
      );
      return { id: row.id, createdAt: row.created_at };
    });
  }

  /** Удалить чеки старше срока хранения (запускается часто: чек живёт не дольше 2 суток). */
  async purgeReceipts() {
    const { rowCount } = await this.db.query(
      `UPDATE payments SET receipt = NULL, receipt_deleted_at = now()
        WHERE receipt IS NOT NULL AND created_at < now() - make_interval(hours => $1)`,
      [this.receiptRetentionHours],
    );
    return rowCount;
  }

  /** Вкладка «Оплаты» в админ-консоли: новые сверху. */
  async list({ limit, offset, q = '' }) {
    // Поиск — по логину или началу IP.
    const term = String(q || '').trim().toLowerCase().slice(0, 64);
    const like = term ? `${term.replace(/[\\%_]/g, (char) => `\\${char}`)}%` : '';
    const rows = await this.db.many(
      `SELECT p.id, p.account_id, p.visitor_id, a.login, a.role, p.created_at, host(p.ip) AS ip, p.user_agent, p.amount,
              p.receipt_type, p.receipt_size, p.receipt_deleted_at,
              (p.receipt IS NOT NULL AND p.created_at > now() - make_interval(hours => $3)) AS has_receipt,
              ban.id AS ban_id, ban.ends_at AS ban_ends_at, ban.reason AS ban_reason
         FROM payments p JOIN accounts a ON a.id = p.account_id
         LEFT JOIN LATERAL (
           SELECT id, ends_at, reason FROM bans
            WHERE account_id = p.account_id AND lifted_at IS NULL AND starts_at <= now() AND (ends_at IS NULL OR ends_at > now())
            ORDER BY ends_at DESC NULLS FIRST LIMIT 1
         ) ban ON true
        WHERE ($4 = '' OR a.login_normalized LIKE $4 OR host(p.ip) LIKE $4)
        ORDER BY p.created_at DESC
        LIMIT $1 OFFSET $2`,
      [limit + 1, offset, this.receiptRetentionHours, like],
    );
    return {
      items: rows.slice(0, limit).map((row) => ({
        id: row.id,
        accountId: row.account_id,
        visitorId: row.visitor_id,
        login: row.login,
        createdAt: row.created_at,
        ip: row.ip,
        ...parseUserAgent(row.user_agent),
        amount: row.amount,
        currency: this.currency,
        receipt: row.has_receipt ? { type: row.receipt_type, size: row.receipt_size } : null,
        receiptDeletedAt: row.receipt_deleted_at,
        ban: row.ban_id ? { id: row.ban_id, endsAt: row.ban_ends_at, forever: row.ban_ends_at === null, reason: row.ban_reason } : null,
      })),
      hasMore: rows.length > limit,
    };
  }

  async count() {
    return (await this.db.one('SELECT count(*)::int AS count FROM payments')).count;
  }

  /** Сам чек — только пока не истёк срок хранения. */
  async receipt(id) {
    if (!isUuid(id)) throw notFound('Чек не найден');
    const row = await this.db.one(
      `SELECT p.id, p.account_id, a.login, p.receipt_type, p.receipt FROM payments p JOIN accounts a ON a.id = p.account_id
        WHERE p.id = $1 AND p.receipt IS NOT NULL AND p.created_at > now() - make_interval(hours => $2)`,
      [id, this.receiptRetentionHours],
    );
    if (!row) throw notFound('Чек не найден или уже удалён (чеки хранятся 2 суток)');
    return { id: row.id, accountId: row.account_id, login: row.login, type: row.receipt_type, bytes: row.receipt };
  }
}
