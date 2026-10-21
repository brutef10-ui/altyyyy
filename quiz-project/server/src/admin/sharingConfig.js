// Веса и пороги подсказок о совместном использовании аккаунтов.
// Можно переопределить переменной окружения SHARING_CONFIG (JSON с теми же ключами), например:
//   SHARING_CONFIG={"thresholds":{"yellow":25,"red":55},"manyDevices":{"limit":4}}
export const SHARING_DEFAULTS = Object.freeze({
  // Окно анализа и ограничения объёма (анализ — только по запросу администратора).
  windowDays: 30,
  maxAccounts: 2000,
  maxEventsPerAccount: 1000,
  maxSessionsPerAccount: 300,
  cacheMinutes: 5,
  thresholds: { yellow: 30, red: 60 },
  // Одновременные сессии с разных устройств и разных подсетей (высокий вес): обе сессии действовали,
  // и обе использовались не дальше windowMinutes друг от друга.
  concurrent: { weight: 40, sameCityFactor: 0.3, windowMinutes: 60 },
  // Смена города или страны быстрее, чем можно доехать (высокий вес).
  geoJump: { weight: 35, minDistanceKm: 300, maxSpeedKmh: 800 },
  // Больше limit разных устройств за 7 дней (средний вес; одно новое устройство не считается).
  manyDevices: { weight: 20, limit: 3, days: 7 },
  // Игры, запущенные одновременно с двух устройств (высокий вес).
  parallelGames: { weight: 40, minutes: 45 },
  // Разные ОС и типы устройств в один день без стабильного основного устройства (средний вес).
  mixedDevices: { weight: 15, minDays: 2, mainShare: 0.6 },
  // Устройства регулярно чередуются по времени суток (низкий вес).
  alternation: { weight: 10, minDaysEach: 3, hourGap: 6 },
});

function merge(base, extra) {
  if (!extra || typeof extra !== 'object') return base;
  const out = { ...base };
  for (const [key, value] of Object.entries(extra)) {
    if (!(key in base)) continue;
    out[key] = base[key] && typeof base[key] === 'object' && !Array.isArray(base[key]) ? merge(base[key], value) : value;
  }
  return out;
}

export function sharingConfig(env = process.env) {
  if (!env.SHARING_CONFIG) return SHARING_DEFAULTS;
  try {
    return merge(SHARING_DEFAULTS, JSON.parse(env.SHARING_CONFIG));
  } catch {
    console.error('[sharing] SHARING_CONFIG — некорректный JSON, используются значения по умолчанию.');
    return SHARING_DEFAULTS;
  }
}
