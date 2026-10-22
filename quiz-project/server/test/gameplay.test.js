import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { hostBrowser, startTestServer } from './helpers.js';

// Новые возможности протокола v2: фаза чтения, ответы вручную, скрытые места, церемония,
// картинки и вход большого числа игроков из одной сети.
const HOST_ORIGIN = 'http://localhost:5500';
let server;
const photo = () => {
  const bytes = Buffer.alloc(300, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
const jpegBytes = (size = 2_000) => {
  const bytes = randomBytes(size);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return bytes;
};

function client(browser) {
  if (browser) return browser.socket();
  return new Promise((resolve, reject) => {
    const socket = connect(server.url, { transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}
const request = (socket, event, payload) => socket.timeout(5000).emitWithAck(event, payload);
const once = (socket, event, filter = () => true) => new Promise((resolve) => {
  const handler = (payload) => {
    if (!filter(payload)) return;
    socket.off(event, handler);
    resolve(payload);
  };
  socket.on(event, handler);
});

async function room(quiz, names) {
  const host = await client(await hostBrowser(server));
  const created = await request(host, 'host:create', { quiz });
  assert.equal(created.ok, true, created.error);
  const players = [];
  for (const nickname of names) {
    const socket = await client();
    const joined = await request(socket, 'player:join', { code: created.code, nickname, photo: photo() });
    assert.equal(joined.ok, true, joined.error);
    players.push(Object.assign(socket, { token: joined.token, playerId: joined.playerId }));
  }
  return { host, code: created.code, players, close: async () => {
    await request(host, 'host:close');
    [host, ...players].forEach((socket) => socket.disconnect());
  } };
}

before(async () => {
  server = await startTestServer('gameplay', {
    hostOrigins: [HOST_ORIGIN],
    playerOrigins: ['http://localhost:5501'],
  });
});

after(async () => {
  await server.close();
});

test('фаза чтения: сначала только вопрос, варианты открываются по таймеру или по команде ведущего', async () => {
  const quiz = { title: 'Чтение', questions: [{ type: 'choice', text: 'Подумайте…', answers: ['Да', 'Нет'], correct: 0, timeLimit: 10, readTime: 3 }] };
  const { host, players: [anna], close } = await room(quiz, ['Анна']);

  const reading = once(anna, 'question', (q) => q.phase === 'reading');
  const hostReading = once(host, 'question', (q) => q.phase === 'reading');
  await request(host, 'host:start');
  const question = await reading;
  assert.equal(question.answers, undefined, 'варианты не должны приходить до конца чтения');
  assert.ok(question.readRemainingMs > 2000 && question.readRemainingMs <= 3000);
  assert.equal((await hostReading).answers, undefined, 'на проекторе вариантов тоже нет');

  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: 0 })).code, 'TOO_EARLY');

  // Ведущий не ждёт — открывает варианты сразу.
  const answering = once(anna, 'question', (q) => q.phase === 'answering');
  await request(host, 'host:next');
  const opened = await answering;
  assert.deepEqual(opened.answers, ['Да', 'Нет']);
  assert.ok(opened.remainingMs > 9000);
  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: 0 })).ok, true);
  await close();
});

test('фаза чтения заканчивается сама', async () => {
  const quiz = { title: 'Чтение', questions: [{ type: 'choice', text: 'Q', answers: ['A', 'B'], correct: 1, timeLimit: 5, readTime: 3 }] };
  const { host, players: [anna], close } = await room(quiz, ['Анна']);
  const answering = once(anna, 'question', (q) => q.phase === 'answering');
  const started = Date.now();
  await request(host, 'host:start');
  await answering;
  assert.ok(Date.now() - started >= 2800, 'варианты открылись не раньше чем через 3 секунды');
  await close();
});

test('вопрос с ответом вручную: регистр, «ё» и опечатки', async () => {
  const quiz = { title: 'Текст', questions: [{ type: 'text', text: 'Столица Франции?', accepted: ['Париж'], timeLimit: 20, readTime: 0 }] };
  const { host, players: [anna, boris, vera], close } = await room(quiz, ['Анна', 'Борис', 'Вера']);

  const opened = once(anna, 'question', (q) => q.phase === 'answering');
  await request(host, 'host:start');
  const question = await opened;
  assert.equal(question.type, 'text');
  assert.equal(question.answers, undefined);
  assert.equal(question.accepted, undefined, 'правильные ответы не уходят игрокам');

  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: '   ' })).code, 'BAD_ANSWER');
  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: 7 })).code, 'BAD_ANSWER');

  const annaResult = once(anna, 'results');
  const borisResult = once(boris, 'results');
  const hostResults = once(host, 'results');
  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: '  париж! ' })).ok, true);
  assert.equal((await request(boris, 'player:answer', { questionIndex: 0, answer: 'Парриж' })).ok, true); // 1 опечатка
  assert.equal((await request(vera, 'player:answer', { questionIndex: 0, answer: 'Лондон' })).ok, true);

  const results = await hostResults;
  assert.deepEqual(results.accepted, ['Париж']);
  assert.equal(results.correctCount, 2);
  assert.equal(results.wrongCount, 1);
  assert.equal(results.noAnswerCount, 0);
  const mine = await annaResult;
  assert.equal(mine.correct, true);
  assert.equal(mine.answer, 'париж!');
  assert.equal((await borisResult).correct, true);
  await close();
});

test('после последнего вопроса места скрыты, церемония раскрывает их по очереди', async () => {
  const quiz = {
    title: 'Финал',
    questions: [{ type: 'choice', text: 'Q', answers: ['A', 'B'], correct: 0, timeLimit: 30, readTime: 0 }],
  };
  const { host, code, players, close } = await room(quiz, ['Первый', 'Второй', 'Третий', 'Четвёртый']);
  const [first, second, third, fourth] = players;

  const opened = once(first, 'question', (q) => q.phase === 'answering');
  await request(host, 'host:start');
  await opened;
  const resultEvents = players.map((socket) => once(socket, 'results'));
  const hostResults = once(host, 'results');
  // Быстрее ответил — выше место; четвёртый ошибается.
  for (const socket of [first, second, third]) {
    assert.equal((await request(socket, 'player:answer', { questionIndex: 0, answer: 0 })).ok, true);
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  await request(fourth, 'player:answer', { questionIndex: 0, answer: 1 });

  const results = await hostResults;
  assert.equal(results.isLast, true);
  assert.equal(results.leaderboardHidden, true);
  assert.deepEqual(results.leaderboard, [], 'на проекторе лидеров после последнего вопроса нет');
  for (const result of await Promise.all(resultEvents)) {
    assert.equal(result.rank, null, 'место скрыто до церемонии');
    assert.equal(result.score, null, 'счёт скрыт до церемонии');
  }

  const ceremonies = players.map((socket) => once(socket, 'game:ceremony'));
  const hostEnd = once(host, 'game:end');
  await request(host, 'host:next');
  const final = await hostEnd;
  await Promise.all(ceremonies);
  assert.deepEqual(final.revealOrder, [3, 2, 1]);
  assert.equal(final.revealed, 0);

  // Пока ничего не раскрыто, игрок при переподключении видит ожидание церемонии.
  first.disconnect();
  const firstAgain = await client();
  const rejoined = await request(firstAgain, 'player:rejoin', { code, token: first.token });
  assert.equal(rejoined.snapshot.ceremony, true);
  assert.equal(rejoined.snapshot.final, undefined);
  assert.equal(rejoined.snapshot.score, null);

  let firstGotEnd = false;
  firstAgain.on('game:end', () => { firstGotEnd = true; });
  const thirdEnd = once(third, 'game:end');
  assert.deepEqual(await request(host, 'host:reveal'), { ok: true, revealed: 1, total: 3 });
  const thirdFinal = await thirdEnd;
  assert.equal(thirdFinal.rank, 3);
  assert.equal(thirdFinal.complete, false);
  assert.equal(thirdFinal.podium, null);
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(firstGotEnd, false, 'победитель ещё не знает своё место');

  const secondEnd = once(second, 'game:end');
  await request(host, 'host:reveal');
  assert.equal((await secondEnd).rank, 2);

  const everyone = [firstAgain, second, third, fourth].map((socket) => once(socket, 'game:end', (data) => data.complete));
  await request(host, 'host:reveal');
  const finals = await Promise.all(everyone);
  assert.equal(finals[0].rank, 1);
  assert.equal(finals[3].rank, 4);
  assert.deepEqual(finals[0].podium.map((row) => row.nickname), ['Первый', 'Второй', 'Третий']);
  assert.deepEqual(await request(host, 'host:reveal'), { ok: true, revealed: 3, total: 3 }, 'повторный показ ничего не ломает');

  firstAgain.disconnect();
  await close();
});

test('картинки к вопросам отключены: загрузка закрыта, у старых игр картинка не показывается', async () => {
  const hostToken = await hostBrowser(server);
  const upload = () => hostToken.fetch('/api/images', { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpegBytes(), raw: true });
  assert.equal((await fetch(`${server.url}/api/images`, { method: 'POST', headers: { 'Content-Type': 'image/jpeg' }, body: jpegBytes() })).status, 410);
  const refused = await upload();
  assert.equal(refused.status, 410);
  assert.equal((await refused.json()).code, 'IMAGES_DISABLED');
  assert.equal((await server.db.one('SELECT count(*)::int AS n FROM images')).n, 0, 'в базу ничего не попало');

  // Поле image в новой игре просто отбрасывается.
  const quiz = (image) => ({ title: 'С картинкой', questions: [{ type: 'choice', text: 'Кто на фото?', image, answers: ['A', 'B'], correct: 0, timeLimit: 10, readTime: 0 }] });
  const saved = await hostToken.json('/api/quizzes', { method: 'POST', body: quiz('a'.repeat(32)) });
  assert.equal(saved.status, 201);
  assert.equal('image' in saved.data.quiz.questions[0], false);

  // Игра, сохранённая раньше с картинкой: ни редактор, ни игра картинку не получают.
  const oldId = randomUUID();
  await server.db.query(
    'INSERT INTO quizzes (id, account_id, title, data, created_at, updated_at) VALUES ($1, $2, $3, $4, now(), now())',
    [oldId, hostToken.account.id, 'Старая с картинкой', quiz('b'.repeat(32))],
  );
  const old = await hostToken.json(`/api/quizzes/${oldId}`);
  assert.equal(old.status, 200);
  assert.equal('image' in old.data.quiz.questions[0], false);

  for (const payload of [{ quizId: oldId }, { quiz: quiz('c'.repeat(32)) }]) {
    const host = await client(hostToken);
    const created = await request(host, 'host:create', payload);
    assert.equal(created.ok, true, created.error);
    const anna = await client();
    await request(anna, 'player:join', { code: created.code, nickname: 'Анна', photo: photo() });
    const opened = once(anna, 'question', (q) => q.phase === 'answering');
    await request(host, 'host:start');
    assert.equal((await opened).image, null);
    await request(host, 'host:close');
    host.disconnect();
    anna.disconnect();
  }
});

test('наплыв: 60 игроков из одной Wi-Fi сети входят и возвращаются после сбоя', async () => {
  const host = await client(await hostBrowser(server));
  const quiz = { title: 'Толпа', questions: [{ type: 'choice', text: 'Q', answers: ['A', 'B'], correct: 0, timeLimit: 30, readTime: 0 }] };
  const { code } = await request(host, 'host:create', { quiz });

  const players = await Promise.all(Array.from({ length: 60 }, async (_, i) => {
    const check = await fetch(`${server.url}/api/rooms/${code}`);
    assert.equal(check.status, 200, `проверка кода игроком ${i + 1}`);
    const nick = await fetch(`${server.url}/api/rooms/${code}/nickname`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ nickname: `Игрок ${i + 1}` }),
    });
    assert.equal(nick.status, 200);
    const socket = await client();
    const joined = await request(socket, 'player:join', { code, nickname: `Игрок ${i + 1}`, photo: photo() });
    assert.equal(joined.ok, true, `вход игрока ${i + 1}: ${joined.error}`);
    socket.token = joined.token;
    return socket;
  }));
  assert.equal(server.rooms.get(code).players.size, 60);

  // Сеть «моргнула»: все переподключаются одновременно.
  const back = await Promise.all(players.map(async (socket) => {
    socket.disconnect();
    const again = await client();
    const response = await request(again, 'player:rejoin', { code, token: socket.token });
    again.disconnect();
    return response.ok;
  }));
  assert.equal(back.filter(Boolean).length, 60, 'все вернулись в игру');

  // Подбор кода по-прежнему ограничен.
  const statuses = [];
  for (let i = 0; i < 35; i += 1) statuses.push((await fetch(`${server.url}/api/rooms/${String(100000 + i)}`)).status);
  assert.ok(statuses.includes(429), 'после 30 неверных кодов — 429');

  await request(host, 'host:close');
  host.disconnect();
});
