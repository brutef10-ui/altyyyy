// Настройки сервера из переменных окружения (.env).
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import dotenv from 'dotenv';

const SERVER_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// .env ищем рядом с server.js, а не в текущей папке терминала.
dotenv.config({ path: path.join(SERVER_ROOT, '.env'), quiet: true });

function originList(value, fallback) {
  const items = String(value ?? '')
    .split(',')
    .map((item) => item.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return items.length ? items : fallback;
}

function integer(value, fallback, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  const number = Number.parseInt(value, 10);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

const trimUrl = (value) => String(value ?? '').trim().replace(/\/+$/, '');

// Публичный адрес сервиса, который хостинги подставляют сами.
function platformUrl(env) {
  if (env.RENDER_EXTERNAL_URL) return trimUrl(env.RENDER_EXTERNAL_URL);
  if (env.RAILWAY_PUBLIC_DOMAIN) return `https://${trimUrl(env.RAILWAY_PUBLIC_DOMAIN)}`;
  return '';
}

function trustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return 1;
  const hops = Number.parseInt(value, 10);
  return Number.isFinite(hops) ? hops : value;
}

const flag = (value, fallback) => (value === 'true' ? true : value === 'false' ? false : fallback);

// Локальной БД и внутренней сети Render (адрес без точек, например dpg-abc123-a) шифрование не нужно,
// внешнему адресу облачной БД — нужно.
function defaultDatabaseSsl(url) {
  try {
    const { hostname } = new URL(url);
    if (!hostname || hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '::1' || !hostname.includes('.')) return 'disable';
    return 'require';
  } catch {
    return 'disable';
  }
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  // Render сам выставляет RENDER=true в окружении сервиса.
  const production = env.NODE_ENV === 'production' || env.RENDER === 'true';
  const hostOrigins = originList(env.HOST_SITE_ORIGIN, ['http://localhost:5500', 'http://127.0.0.1:5500']);
  const playerOrigins = originList(env.PLAYER_SITE_ORIGIN, ['http://localhost:5501', 'http://127.0.0.1:5501']);

  const config = {
    port: integer(env.PORT, 3000, { min: 0, max: 65535 }),
    hostOrigins,
    playerOrigins,
    // SERVE_SITES=true: сервер сам отдаёт оба сайта (игрок — «/», ведущий — «/host/»).
    // Удобно для деплоя одним сервисом и для запуска на телефоне.
    serveSites: env.SERVE_SITES === 'true',
    sitesRoot: path.resolve(SERVER_ROOT, '..'),
    dataFile: path.resolve(SERVER_ROOT, env.DATA_FILE || 'data/quizzes.json'),
    imageGcMinAgeMs: 48 * 60 * 60_000,
    imageGcIntervalMs: 60 * 60_000,
    // Сколько мегабайт картинок к вопросам может хранить один аккаунт.
    imageQuotaMb: integer(env.IMAGE_QUOTA_MB, 50, { min: 1, max: 1024 }),
    trustProxy: trustProxy(env.TRUST_PROXY),
    hostReconnectMs: integer(env.HOST_RECONNECT_MS, 15_000, { min: 1_000, max: 300_000 }),
    // Игрок, у которого погас экран или пропала сеть в лобби, остаётся в комнате 10 минут.
    playerReconnectMs: integer(env.PLAYER_RECONNECT_MS, 600_000, { min: 1_000, max: 3_600_000 }),
    maxPlayersPerRoom: integer(env.MAX_PLAYERS_PER_ROOM, 200, { min: 1, max: 1_000 }),
    maxRooms: integer(env.MAX_ROOMS, 500, { min: 1, max: 100_000 }),
    // Завершённая игра живёт ещё 15 минут, любая комната — не дольше 6 часов.
    finishedRoomTtlMs: 15 * 60_000,
    roomMaxAgeMs: 6 * 60 * 60_000,
    roomSweepIntervalMs: 60_000,
    // Сессия ведущего перепроверяется перед командами хода игры не реже, чем раз в столько мс.
    hostSessionRecheckMs: 15_000,

    production,
    // ---------- База данных ----------
    databaseUrl: env.DATABASE_URL || '',
    databaseSsl: env.DATABASE_SSL || defaultDatabaseSsl(env.DATABASE_URL),
    databaseSchema: env.DATABASE_SCHEMA || '',
    // ---------- Вход и сессии ----------
    // Секрет для подписи CSRF-токенов. На Render — обязательная переменная окружения.
    sessionSecret: env.SESSION_SECRET || '',
    // Secure-cookie (только HTTPS). По умолчанию включено на Render и при NODE_ENV=production.
    cookieSecure: flag(env.COOKIE_SECURE, production),
    sessionIdleDays: integer(env.SESSION_IDLE_DAYS, 14, { min: 1, max: 90 }),
    sessionAbsoluteDays: integer(env.SESSION_ABSOLUTE_DAYS, 60, { min: 1, max: 365 }),
    // Регистрации: не больше N с одного IP в час и не больше M на весь сайт в час (защита от авторегистраций).
    registrationsPerIpPerHour: integer(env.REGISTRATIONS_PER_IP_PER_HOUR, 5, { min: 1, max: 1_000 }),
    registrationsPerHour: integer(env.REGISTRATIONS_PER_HOUR, 300, { min: 1, max: 100_000 }),
    // Сколько минут действует одноразовый код восстановления, выданный администратором.
    recoveryCodeTtlMinutes: integer(env.RECOVERY_CODE_TTL_MINUTES, 60, { min: 5, max: 7 * 24 * 60 }),
    // ---------- Сроки хранения (дни) ----------
    // Журнал заходов: обезличить (IP → сеть, без user-agent) и удалить.
    eventsAnonymizeDays: integer(env.EVENTS_ANONYMIZE_DAYS, 180, { min: 1, max: 3650 }),
    eventsDeleteDays: integer(env.EVENTS_DELETE_DAYS, 1095, { min: 1, max: 3650 }),
    // Журнал действий администратора и история блокировок (после снятия или окончания).
    auditRetentionDays: integer(env.AUDIT_RETENTION_DAYS, 1095, { min: 30, max: 3650 }),
    banHistoryRetentionDays: integer(env.BAN_HISTORY_RETENTION_DAYS, 1095, { min: 30, max: 3650 }),
    // Часовой пояс для подсказок о шаринге («чередование устройств по времени суток»).
    sharingTimeZone: String(env.SHARING_TIMEZONE || 'Europe/Moscow'),
    // ---------- Резервные копии ----------
    backup: {
      encryptionKey: String(env.BACKUP_ENCRYPTION_KEY || '').trim(),
      intervalHours: integer(env.BACKUP_INTERVAL_HOURS, 24, { min: 1, max: 24 * 7 }),
      keep: integer(env.BACKUP_KEEP, 14, { min: 1, max: 365 }),
      // Папка для копий без Google Drive (локально; на Render диск временный — только для проверки).
      dir: env.BACKUP_DIR ? path.resolve(SERVER_ROOT, env.BACKUP_DIR) : '',
      googleDrive: {
        clientId: String(env.GOOGLE_DRIVE_CLIENT_ID || '').trim(),
        clientSecret: String(env.GOOGLE_DRIVE_CLIENT_SECRET || '').trim(),
        refreshToken: String(env.GOOGLE_DRIVE_REFRESH_TOKEN || '').trim(),
        folderId: String(env.GOOGLE_DRIVE_FOLDER_ID || '').trim(),
      },
    },
    // ---------- IP клиента за прокси (docs/ACCOUNTS_PLAN.md, раздел 4) ----------
    // hops: N-й адрес справа в X-Forwarded-For; header: заголовок, который выставляет доверенный прокси.
    clientIpMode: env.CLIENT_IP_MODE === 'header' ? 'header' : 'hops',
    clientIpHeader: String(env.CLIENT_IP_HEADER || '').trim().toLowerCase(),
    // ---------- Администратор (только из окружения сервера) ----------
    adminLogin: String(env.ADMIN_LOGIN || '').trim(),
    adminPasswordHash: String(env.ADMIN_PASSWORD_HASH || '').trim(),
    adminContact: String(env.ADMIN_CONTACT || '').trim(),
    ...overrides,
  };

  // Сколько последних прокси добавляют свой адрес в X-Forwarded-For. По умолчанию — как TRUST_PROXY.
  if (config.trustProxyHops === undefined) {
    const fallback = typeof config.trustProxy === 'number' ? config.trustProxy : config.trustProxy ? 1 : 0;
    config.trustProxyHops = integer(env.TRUST_PROXY_HOPS, fallback, { min: 0, max: 10 });
  }

  // Картинки к вопросам хранятся рядом с файлом игр (на том же постоянном диске).
  config.imagesDir ??= path.join(path.dirname(config.dataFile), 'images');

  if (config.playerSiteUrl === undefined) {
    // Без адреса в режиме SERVE_SITES лобби покажет адрес, с которого открыт сайт ведущего.
    config.playerSiteUrl = trimUrl(env.PLAYER_SITE_URL) || (config.serveSites ? platformUrl(env) : config.playerOrigins[0]) || null;
  }
  // Куда ведёт кнопка «Создать свою игру» на сайте игрока. null — сайт ведущего рядом, по адресу /host/.
  if (config.hostSiteUrl === undefined) {
    config.hostSiteUrl = trimUrl(env.HOST_SITE_URL) || (config.serveSites ? null : config.hostOrigins[0]) || null;
  }
  config.allOrigins = [...new Set([...config.hostOrigins, ...config.playerOrigins])];
  return Object.freeze(config);
}
