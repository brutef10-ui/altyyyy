// Сроки хранения персональных данных. Запускается раз в сутки внутри процесса, небольшими порциями.
//
// * Журнал заходов: через eventsAnonymizeDays IP обрезается до сети (/24 для IPv4, /48 для IPv6),
//   user-agent удаляется; тип устройства, ОС, браузер и связи с посетителем/аккаунтом остаются
//   (подсчёты в админ-консоли не ломаются). Через eventsDeleteDays записи удаляются.
// * Посетители, которых не было eventsAnonymizeDays: так же обрезаются последний IP и user-agent.
// * Журнал администратора и история блокировок — отдельный срок (auditRetentionDays, banHistoryRetentionDays).
const BATCH = 5_000;

export class Retention {
  constructor(db, config) {
    this.db = db;
    this.config = config;
  }

  async #batched(sql, params) {
    let total = 0;
    for (;;) {
      const { rowCount } = await this.db.query(sql, [...params, BATCH]);
      total += rowCount;
      if (rowCount < BATCH) return total;
    }
  }

  async run() {
    const { eventsAnonymizeDays, eventsDeleteDays, auditRetentionDays, banHistoryRetentionDays } = this.config;
    const anonymizedEvents = await this.#batched(
      `WITH batch AS (
         SELECT id FROM events WHERE anonymized_at IS NULL AND created_at < now() - make_interval(days => $1)
         ORDER BY created_at LIMIT $2
       )
       UPDATE events e SET
         ip = CASE WHEN e.ip IS NULL THEN NULL
                   WHEN family(e.ip) = 4 THEN network(set_masklen(e.ip, 24))::inet
                   ELSE network(set_masklen(e.ip, 48))::inet END,
         user_agent = NULL,
         anonymized_at = now()
       FROM batch WHERE e.id = batch.id`,
      [eventsAnonymizeDays],
    );
    const deletedEvents = await this.#batched(
      `DELETE FROM events WHERE id IN (
         SELECT id FROM events WHERE created_at < now() - make_interval(days => $1) ORDER BY created_at LIMIT $2
       )`,
      [eventsDeleteDays],
    );
    const anonymizedVisitors = await this.#batched(
      `WITH batch AS (
         SELECT id FROM visitors
          WHERE last_seen_at < now() - make_interval(days => $1)
            AND (last_user_agent IS NOT NULL OR (last_ip IS NOT NULL AND masklen(last_ip) IN (32, 128)))
          LIMIT $2
       )
       UPDATE visitors v SET
         last_ip = CASE WHEN v.last_ip IS NULL THEN NULL
                        WHEN family(v.last_ip) = 4 THEN network(set_masklen(v.last_ip, 24))::inet
                        ELSE network(set_masklen(v.last_ip, 48))::inet END,
         last_user_agent = NULL
       FROM batch WHERE v.id = batch.id`,
      [eventsAnonymizeDays],
    );
    const deletedAudit = await this.#batched(
      'DELETE FROM admin_audit WHERE id IN (SELECT id FROM admin_audit WHERE created_at < now() - make_interval(days => $1) LIMIT $2)',
      [auditRetentionDays],
    );
    const deletedBans = await this.#batched(
      `DELETE FROM bans WHERE id IN (
         SELECT id FROM bans
          WHERE COALESCE(lifted_at, ends_at) < now() - make_interval(days => $1)
          LIMIT $2
       )`,
      [banHistoryRetentionDays],
    );
    const deletedCodes = await this.#batched(
      `DELETE FROM recovery_codes WHERE id IN (
         SELECT id FROM recovery_codes
          WHERE COALESCE(used_at, revoked_at, expires_at) < now() - interval '30 days'
          LIMIT $1
       )`,
      [],
    );
    return { anonymizedEvents, deletedEvents, anonymizedVisitors, deletedAudit, deletedBans, deletedCodes };
  }
}
