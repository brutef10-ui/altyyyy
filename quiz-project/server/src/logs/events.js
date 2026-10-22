// Журнал заходов (таблица events). Запись не задерживает игру: ошибки записи только логируются.
// Пароли, коды и токены сюда никогда не попадают.
import { parseUserAgent } from './userAgent.js';

export const EVENT_TYPES = Object.freeze({
  register: 'account_register',
  login: 'account_login',
  recover: 'account_recover',
  roomJoin: 'room_join',
  roomCreate: 'room_create',
  quizCreate: 'quiz_create',
  payment: 'payment_receipt',
});

const text = (value, max) => (typeof value === 'string' && value ? value.slice(0, max) : null);

export class EventLog {
  constructor(db) {
    this.db = db;
  }

  /**
   * identity — req.identity или socket.identity ({ ip, userAgent, visitorId, account }).
   * Возвращает промис, который никогда не отклоняется.
   */
  record(type, identity = {}, { account = identity.account, nickname = null, roomCode = null, details = {} } = {}) {
    const agent = identity.parsedAgent ?? parseUserAgent(identity.userAgent);
    if (identity && !identity.parsedAgent) identity.parsedAgent = agent;
    return this.db.query(
      `INSERT INTO events (type, visitor_id, account_id, account_login, nickname, room_code, details, ip, user_agent, device_type, os, browser)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [
        type,
        identity.visitorId ?? null,
        account?.id ?? null,
        account?.login ?? null,
        text(nickname, 40),
        text(roomCode, 12),
        details,
        identity.ip ?? null,
        text(identity.userAgent, 400),
        agent.deviceType,
        agent.os,
        agent.browser,
      ],
    ).then(() => true, (error) => {
      console.error(`[events] не удалось записать ${type}:`, error.message);
      return false;
    });
  }
}
