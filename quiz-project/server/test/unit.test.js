import { test } from 'node:test';
import assert from 'node:assert/strict';
import { calculatePoints, rankPlayers, MAX_POINTS } from '../src/scoring.js';
import { validateNickname, validatePhoto, validateQuiz, validateRoomCode, validateAnswerIndex, MAX_PHOTO_BYTES } from '../src/validate.js';
import { Game, STATES } from '../src/game.js';
import { PlayerRegistry } from '../src/players.js';

const jpeg = (size = 200) => {
  const bytes = Buffer.alloc(size, 0x11);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};

test('очки: неправильный ответ даёт 0, быстрый правильный — больше медленного', () => {
  assert.equal(calculatePoints({ correct: false, elapsedMs: 100, timeLimitMs: 20_000 }), 0);
  assert.equal(calculatePoints({ correct: true, elapsedMs: 0, timeLimitMs: 20_000 }), MAX_POINTS);
  assert.equal(calculatePoints({ correct: true, elapsedMs: 20_000, timeLimitMs: 20_000 }), 500);
  const fast = calculatePoints({ correct: true, elapsedMs: 2_000, timeLimitMs: 20_000 });
  const slow = calculatePoints({ correct: true, elapsedMs: 15_000, timeLimitMs: 20_000 });
  assert.ok(fast > slow && fast <= MAX_POINTS);
});

test('рейтинг: одинаковые очки — одинаковое место', () => {
  const ranking = rankPlayers([
    { id: 'a', score: 900, joinedAt: 1 },
    { id: 'b', score: 1500, joinedAt: 2 },
    { id: 'c', score: 900, joinedAt: 3 },
    { id: 'd', score: 100, joinedAt: 4 },
  ]);
  assert.deepEqual(ranking.map(({ player, rank }) => [player.id, rank]), [['b', 1], ['a', 2], ['c', 2], ['d', 4]]);
});

test('код комнаты: только 6 цифр', () => {
  assert.equal(validateRoomCode('123456').value, '123456');
  assert.equal(validateRoomCode('123 456').value, '123456');
  assert.equal(validateRoomCode('12345').ok, false);
  assert.equal(validateRoomCode('12a456').ok, false);
  assert.equal(validateRoomCode({}).ok, false);
});

test('ник: длина и допустимые символы', () => {
  assert.equal(validateNickname('  Маша   К ').value, 'Маша К');
  assert.equal(validateNickname('Player_1.x-y').ok, true);
  assert.equal(validateNickname('Ё').ok, false);
  assert.equal(validateNickname('a'.repeat(17)).ok, false);
  assert.equal(validateNickname('<script>').ok, false);
  assert.equal(validateNickname('___').ok, false);
  assert.equal(validateNickname(42).ok, false);
});

test('фото: только JPEG/PNG data URL не больше 100 КБ', () => {
  assert.equal(validatePhoto(jpeg()).ok, true);
  assert.equal(validatePhoto(jpeg(MAX_PHOTO_BYTES + 1)).ok, false);
  assert.equal(validatePhoto('data:image/gif;base64,R0lGODlhAQABAAAAACw=').ok, false);
  assert.equal(validatePhoto(`data:image/png;base64,${Buffer.alloc(200, 1).toString('base64')}`).ok, false, 'неверная сигнатура');
  assert.equal(validatePhoto('').ok, false);
  assert.equal(validatePhoto('javascript:alert(1)').ok, false);
});

test('номер ответа: целое число в пределах вариантов', () => {
  assert.equal(validateAnswerIndex(2, 4).ok, true);
  assert.equal(validateAnswerIndex(4, 4).ok, false);
  assert.equal(validateAnswerIndex(-1, 4).ok, false);
  assert.equal(validateAnswerIndex('1', 4).ok, false);
  assert.equal(validateAnswerIndex(1.5, 4).ok, false);
});

test('квиз: валидация структуры', () => {
  const good = validateQuiz({ title: ' Тест ', questions: [{ text: 'Q?', answers: ['a', 'b'], correct: 1, timeLimit: 20 }] });
  assert.equal(good.ok, true);
  assert.equal(good.value.title, 'Тест');

  const bad = validateQuiz({ title: '', questions: [{ text: '', answers: ['a'], correct: 3, timeLimit: 7 }] });
  assert.equal(bad.ok, false);
  assert.ok(bad.errors.length >= 4);
});

function makeGame() {
  let time = 1_000_000;
  const events = [];
  const timers = new Map();
  let timerId = 0;
  const players = new PlayerRegistry({ maxPlayers: 10 });
  const game = new Game({
    quiz: {
      title: 'Тест',
      questions: [
        { text: '2+2?', answers: ['3', '4'], correct: 1, timeLimit: 10 },
        { text: 'Столица?', answers: ['Москва', 'Казань', 'Сочи'], correct: 0, timeLimit: 20 },
      ],
    },
    players,
    notify: {
      host: (event, payload) => events.push(['host', event, payload]),
      allPlayers: (event, payload) => events.push(['all', event, payload]),
      player: (player, event, payload) => events.push([player.id, event, payload]),
    },
    now: () => time,
    timers: {
      setTimeout: (fn, ms) => { timerId += 1; timers.set(timerId, { fn, at: time + ms }); return timerId; },
      clearTimeout: (id) => timers.delete(id),
    },
  });
  const advance = (ms) => {
    time += ms;
    for (const [id, timer] of [...timers]) {
      if (timer.at <= time) { timers.delete(id); timer.fn(); }
    }
  };
  return { game, players, events, advance };
}

test('игра: полный цикл lobby → question → results → final', () => {
  const { game, players, events, advance } = makeGame();
  assert.throws(() => game.start(), /хотя бы один игрок/);

  const anna = players.add({ nickname: 'Анна', avatar: jpeg(), socketId: 's1' });
  const boris = players.add({ nickname: 'Борис', avatar: jpeg(), socketId: 's2' });
  assert.throws(() => game.next(), /недоступно/);

  game.start();
  assert.equal(game.state, STATES.QUESTION);
  const question = events.find(([to, event]) => to === 'all' && event === 'question')[2];
  assert.equal(question.correct, undefined, 'игрок не должен знать правильный ответ');

  advance(1_000);
  game.submitAnswer(anna.id, { questionIndex: 0, answer: 1 });
  assert.throws(() => game.submitAnswer(anna.id, { questionIndex: 0, answer: 1 }), /уже ответили/);
  assert.throws(() => game.submitAnswer(boris.id, { questionIndex: 0, answer: 9 }), /Некорректный/);
  assert.throws(() => game.submitAnswer(boris.id, { questionIndex: 1, answer: 0 }), /вышло/);

  advance(9_500); // таймер истёк
  assert.equal(game.state, STATES.RESULTS);
  assert.throws(() => game.submitAnswer(boris.id, { questionIndex: 0, answer: 1 }), /вышло/);
  assert.equal(anna.score, 950);
  assert.equal(boris.score, 0);
  const annaResult = events.find(([to, event]) => to === anna.id && event === 'results')[2];
  assert.equal(annaResult.correct, true);
  assert.equal(annaResult.rank, 1);

  game.next();
  assert.equal(game.state, STATES.QUESTION);
  game.submitAnswer(anna.id, { questionIndex: 1, answer: 2 });
  game.submitAnswer(boris.id, { questionIndex: 1, answer: 0 }); // все ответили → вопрос закрывается сразу
  assert.equal(game.state, STATES.RESULTS);
  assert.equal(boris.score, 1000);

  game.next();
  assert.equal(game.state, STATES.FINAL);
  const final = events.find(([to, event]) => to === 'host' && event === 'game:end')[2];
  assert.deepEqual(final.leaderboard.map((row) => [row.nickname, row.rank]), [['Борис', 1], ['Анна', 2]]);
  assert.throws(() => game.next(), /недоступно/);
});

test('игра: ведущий может закрыть вопрос досрочно', () => {
  const { game, players } = makeGame();
  players.add({ nickname: 'Анна', avatar: jpeg(), socketId: 's1' });
  game.start();
  game.next();
  assert.equal(game.state, STATES.RESULTS);
});
