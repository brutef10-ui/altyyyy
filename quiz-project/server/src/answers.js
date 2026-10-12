// Проверка ответов, введённых вручную (вопросы типа «text»).
//
// Ответ засчитывается, если после нормализации совпадает с одним из правильных вариантов.
// Нормализация: регистр, «ё» = «е», знаки препинания, кавычки и лишние пробелы не учитываются.
// В длинных ответах без цифр прощаются опечатки: 1 — от 5 символов, 2 — от 10 символов.

export function normalizeTextAnswer(value) {
  return String(value ?? '')
    .normalize('NFC')
    .toLocaleLowerCase('ru-RU')
    .replace(/ё/g, 'е')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

// Расстояние Левенштейна с ранним выходом, если оно заведомо больше limit.
function editDistance(a, b, limit) {
  const left = [...a];
  const right = [...b];
  if (Math.abs(left.length - right.length) > limit) return limit + 1;
  let previous = Array.from({ length: right.length + 1 }, (_, j) => j);
  for (let i = 1; i <= left.length; i += 1) {
    const current = [i];
    let rowMin = current[0];
    for (let j = 1; j <= right.length; j += 1) {
      const cost = left[i - 1] === right[j - 1] ? 0 : 1;
      current[j] = Math.min(previous[j] + 1, current[j - 1] + 1, previous[j - 1] + cost);
      rowMin = Math.min(rowMin, current[j]);
    }
    if (rowMin > limit) return limit + 1;
    previous = current;
  }
  return previous[right.length];
}

function allowedTypos(expected) {
  if (/\p{N}/u.test(expected)) return 0; // числа и даты — только точно
  const length = [...expected.replace(/ /g, '')].length;
  if (length >= 10) return 2;
  if (length >= 5) return 1;
  return 0;
}

export function isTextAnswerCorrect(answer, accepted) {
  const given = normalizeTextAnswer(answer);
  if (!given) return false;
  return accepted.some((variant) => {
    const expected = normalizeTextAnswer(variant);
    if (!expected) return false;
    if (given === expected) return true;
    const typos = allowedTypos(expected);
    return typos > 0 && editDistance(given, expected, typos) <= typos;
  });
}
