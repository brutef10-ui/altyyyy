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

function trustProxy(value) {
  if (value === undefined || value === '' || value === 'false') return false;
  if (value === 'true') return 1;
  const hops = Number.parseInt(value, 10);
  return Number.isFinite(hops) ? hops : value;
}

export function loadConfig(overrides = {}) {
  const env = process.env;
  const hostOrigins = originList(env.HOST_SITE_ORIGIN, ['http://localhost:5500', 'http://127.0.0.1:5500']);
  const playerOrigins = originList(env.PLAYER_SITE_ORIGIN, ['http://localhost:5501', 'http://127.0.0.1:5501']);

  const config = {
    port: integer(env.PORT, 3000, { min: 0, max: 65535 }),
    hostOrigins,
    playerOrigins,
    playerSiteUrl: (env.PLAYER_SITE_URL || '').trim().replace(/\/+$/, '') || playerOrigins[0],
    dataFile: path.resolve(SERVER_ROOT, env.DATA_FILE || 'data/quizzes.json'),
    trustProxy: trustProxy(env.TRUST_PROXY),
    hostReconnectMs: integer(env.HOST_RECONNECT_MS, 15_000, { min: 1_000, max: 300_000 }),
    playerReconnectMs: integer(env.PLAYER_RECONNECT_MS, 30_000, { min: 1_000, max: 600_000 }),
    maxPlayersPerRoom: integer(env.MAX_PLAYERS_PER_ROOM, 100, { min: 1, max: 1_000 }),
    maxRooms: integer(env.MAX_ROOMS, 500, { min: 1, max: 100_000 }),
    // Завершённая игра живёт ещё 15 минут, любая комната — не дольше 6 часов.
    finishedRoomTtlMs: 15 * 60_000,
    roomMaxAgeMs: 6 * 60 * 60_000,
    roomSweepIntervalMs: 60_000,
    ...overrides,
  };

  config.allOrigins = [...new Set([...config.hostOrigins, ...config.playerOrigins])];
  return Object.freeze(config);
}
