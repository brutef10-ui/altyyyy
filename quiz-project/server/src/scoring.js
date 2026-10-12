// Подсчёт очков и рейтинга.

export const MAX_POINTS = 1000;
// Самый медленный правильный ответ получает половину максимума.
const SLOWEST_SHARE = 0.5;

/**
 * Очки за ответ: неправильный — 0, правильный — до 1000.
 * Чем быстрее ответ, тем больше очков: мгновенный ответ даёт 1000,
 * ответ в последнюю миллисекунду — 500.
 */
export function calculatePoints({ correct, elapsedMs, timeLimitMs }) {
  if (!correct) return 0;
  if (!(timeLimitMs > 0)) return MAX_POINTS;
  const ratio = Math.min(1, Math.max(0, elapsedMs / timeLimitMs));
  return Math.round(MAX_POINTS * (1 - ratio * (1 - SLOWEST_SHARE)));
}

/**
 * Рейтинг игроков по очкам. При равенстве очков место одинаковое («1, 1, 3»),
 * порядок внутри — по времени входа в комнату.
 */
export function rankPlayers(players) {
  const sorted = [...players].sort((a, b) => b.score - a.score || a.joinedAt - b.joinedAt);
  let previousScore = null;
  let previousRank = 0;
  return sorted.map((player, index) => {
    const rank = player.score === previousScore ? previousRank : index + 1;
    previousScore = player.score;
    previousRank = rank;
    return { player, rank };
  });
}
