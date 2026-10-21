// Журнал действий администратора (таблица admin_audit). Пишется на каждое изменяющее действие админа.
// В details никогда не попадают пароли и коды — только факты (кому, на какой срок и т. п.).
export class AuditLog {
  constructor(db) {
    this.db = db;
  }

  /** runner — db или транзакция (чтобы запись в журнал и само действие сохранялись вместе). */
  async record({ admin, action, targetType = null, targetId = null, details = {}, ip = null, userAgent = null }, runner = this.db) {
    await runner.query(
      `INSERT INTO admin_audit (admin_id, admin_login, action, target_type, target_id, details, ip, user_agent)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [admin?.id ?? null, admin?.login ?? null, action, targetType, targetId === null ? null : String(targetId), details, ip, userAgent?.slice(0, 400) ?? null],
    );
  }
}
