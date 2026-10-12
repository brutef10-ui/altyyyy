import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { io as connect } from 'socket.io-client';
import { startServer } from '../server.js';

const HOST_ORIGIN = 'http://localhost:5500';
let server;
let tempDir;

const token = () => randomBytes(32).toString('hex');
const photo = () => {
  const bytes = Buffer.alloc(300, 7);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};
const quiz = {
  title: 'Интеграционный тест',
  questions: [
    { text: 'Сколько будет 2+2?', answers: ['3', '4', '5', '22'], correct: 1, timeLimit: 5 },
    { text: 'Цвет неба?', answers: ['Синий', 'Зелёный'], correct: 0, timeLimit: 5 },
  ],
};

function api(pathname, { method = 'GET', body, hostToken, origin = HOST_ORIGIN } = {}) {
  const headers = { Origin: origin };
  if (hostToken) headers.Authorization = `Bearer ${hostToken}`;
  if (body) headers['Content-Type'] = 'application/json';
  return fetch(server.url + pathname, { method, headers, body: body ? JSON.stringify(body) : undefined });
}

function client(auth) {
  return new Promise((resolve, reject) => {
    const socket = connect(server.url, { auth, transports: ['websocket'], forceNew: true, reconnection: false });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

const request = (socket, event, payload) => socket.timeout(3000).emitWithAck(event, payload);
const once = (socket, event) => new Promise((resolve) => socket.once(event, resolve));

before(async () => {
  tempDir = await mkdtemp(path.join(os.tmpdir(), 'iskra-test-'));
  server = await startServer({
    port: 0,
    dataFile: path.join(tempDir, 'quizzes.json'),
    hostOrigins: [HOST_ORIGIN],
    playerOrigins: ['http://localhost:5501'],
    hostReconnectMs: 300,
    playerReconnectMs: 300,
  });
});

after(async () => {
  await server.close();
  await rm(tempDir, { recursive: true, force: true });
});

test('REST: CRUD игр привязан к токену ведущего', async () => {
  const owner = token();
  const stranger = token();

  assert.equal((await api('/api/quizzes')).status, 401);

  const created = await api('/api/quizzes', { method: 'POST', body: quiz, hostToken: owner });
  assert.equal(created.status, 201);
  const { quiz: saved } = await created.json();
  assert.equal(saved.ownerId, undefined, 'ownerId не должен уходить клиенту');

  const list = await (await api('/api/quizzes', { hostToken: owner })).json();
  assert.equal(list.quizzes.length, 1);
  assert.equal(list.quizzes[0].questionCount, 2);

  assert.equal((await api(`/api/quizzes/${saved.id}`, { hostToken: stranger })).status, 404, 'чужая игра не видна');
  assert.equal((await api(`/api/quizzes/${saved.id}`, { method: 'DELETE', hostToken: stranger })).status, 404);

  const invalid = await api('/api/quizzes', { method: 'POST', body: { title: '', questions: [] }, hostToken: owner });
  assert.equal(invalid.status, 422);
  assert.ok((await invalid.json()).details.length >= 2);

  const updated = await api(`/api/quizzes/${saved.id}`, { method: 'PUT', body: { ...quiz, title: 'Новое имя' }, hostToken: owner });
  assert.equal((await updated.json()).quiz.title, 'Новое имя');

  assert.equal((await api(`/api/quizzes/${saved.id}`, { method: 'DELETE', hostToken: owner })).status, 204);
  assert.equal((await (await api('/api/quizzes', { hostToken: owner })).json()).quizzes.length, 0);
});

test('CORS: игры доступны только сайту ведущего', async () => {
  const fromHost = await api('/api/quizzes', { hostToken: token() });
  assert.equal(fromHost.headers.get('access-control-allow-origin'), HOST_ORIGIN);
  const fromPlayer = await api('/api/quizzes', { hostToken: token(), origin: 'http://localhost:5501' });
  assert.equal(fromPlayer.headers.get('access-control-allow-origin'), null);
  const roomFromPlayer = await api('/api/rooms/123456', { origin: 'http://localhost:5501' });
  assert.equal(roomFromPlayer.headers.get('access-control-allow-origin'), 'http://localhost:5501');
});

test('Socket.IO: полная игра от лобби до финала', async () => {
  const hostToken = token();
  const host = await client({ token: hostToken });

  const { quiz: saved } = await (await api('/api/quizzes', { method: 'POST', body: quiz, hostToken })).json();
  const created = await request(host, 'host:create', { quizId: saved.id });
  assert.equal(created.ok, true);
  assert.match(created.code, /^\d{6}$/);
  const { code } = created;

  // Проверка комнаты по REST.
  assert.equal((await api(`/api/rooms/${code}`)).status, 200);
  assert.equal((await api('/api/rooms/000000')).status, 404);

  const anna = await client();
  const lobbyJoin = once(host, 'lobby:update');
  const joined = await request(anna, 'player:join', { code, nickname: 'Анна', photo: photo() });
  assert.equal(joined.ok, true, joined.error);
  const update = await lobbyJoin;
  assert.equal(update.action, 'join');
  assert.equal(update.player.nickname, 'Анна');
  assert.ok(update.player.avatar.startsWith('data:image/jpeg'));

  // Ник уникален, фото обязательно и проверяется.
  const boris = await client();
  assert.equal((await request(boris, 'player:join', { code, nickname: 'анна', photo: photo() })).code, 'NICKNAME_TAKEN');
  assert.equal((await request(boris, 'player:join', { code, nickname: 'Борис' })).code, 'BAD_PHOTO');
  assert.equal((await request(boris, 'player:join', { code, nickname: 'Борис', photo: 'data:image/svg+xml;base64,PHN2Zz4=' })).code, 'BAD_PHOTO');
  const nickCheck = await api(`/api/rooms/${code}/nickname`, { method: 'POST', body: { nickname: 'АННА' } });
  assert.equal(nickCheck.status, 409);
  assert.equal((await request(boris, 'player:join', { code, nickname: 'Борис', photo: photo() })).ok, true);

  // Команды ведущего только от сокета ведущего.
  assert.equal((await request(anna, 'host:start')).code, 'FORBIDDEN');
  const intruder = await client({ token: token() });
  assert.equal((await request(intruder, 'host:start')).code, 'FORBIDDEN');
  assert.equal((await request(intruder, 'host:resume', { code, hostKey: created.hostKey })).code, 'ROOM_NOT_FOUND', 'чужой токен не может забрать комнату');

  const annaQuestion = once(anna, 'question');
  const hostQuestion = once(host, 'question');
  assert.equal((await request(host, 'host:start')).ok, true);
  const question = await annaQuestion;
  assert.equal(question.index, 0);
  assert.equal(question.correct, undefined);
  assert.equal((await hostQuestion).answers.length, 4);

  // Войти после старта нельзя.
  const late = await client();
  assert.equal((await request(late, 'player:join', { code, nickname: 'Опоздал', photo: photo() })).code, 'GAME_STARTED');
  assert.equal((await api(`/api/rooms/${code}`)).status, 409);

  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: 7 })).code, 'BAD_ANSWER');
  const annaResults = once(anna, 'results');
  const hostResults = once(host, 'results');
  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: 1 })).ok, true);
  assert.equal((await request(anna, 'player:answer', { questionIndex: 0, answer: 1 })).code, 'ALREADY_ANSWERED');
  assert.equal((await request(boris, 'player:answer', { questionIndex: 0, answer: 0 })).ok, true);

  const myResult = await annaResults;
  assert.equal(myResult.correct, true);
  assert.ok(myResult.points > 900 && myResult.points <= 1000);
  const results = await hostResults;
  assert.deepEqual(results.counts, [1, 1, 0, 0]);
  assert.equal(results.leaderboard[0].nickname, 'Анна');
  assert.equal((await request(boris, 'player:answer', { questionIndex: 0, answer: 1 })).code, 'TOO_LATE');

  // Второй вопрос закрывает ведущий досрочно, затем финал.
  const nextQuestion = once(anna, 'question');
  await request(host, 'host:next');
  assert.equal((await nextQuestion).index, 1);
  const earlyResults = once(host, 'results');
  await request(host, 'host:next');
  assert.equal((await earlyResults).isLast, true);

  const annaEnd = once(anna, 'game:end');
  const hostEnd = once(host, 'game:end');
  await request(host, 'host:next');
  const final = await hostEnd;
  assert.equal(final.leaderboard.length, 2);
  assert.equal((await annaEnd).rank, 1);

  // Ведущий ушёл и не вернулся → комната закрывается, игроки получают уведомление.
  const closed = once(anna, 'room:closed');
  host.disconnect();
  const notice = await closed;
  assert.equal(notice.reason, 'host-left');
  assert.equal(notice.finished, true);
  assert.equal(server.rooms.get(code), null);

  for (const socket of [anna, boris, intruder, late]) socket.disconnect();
});

test('Socket.IO: ведущий возвращается по ключу, игрок — по токену', async () => {
  const hostToken = token();
  const host = await client({ token: hostToken });
  const { code, hostKey } = await request(host, 'host:create', { quiz });

  const player = await client();
  const joined = await request(player, 'player:join', { code, nickname: 'Вера', photo: photo() });

  // Переход ведущего на другую страницу: старый сокет закрылся, новый восстановил комнату.
  host.disconnect();
  const host2 = await client({ token: hostToken });
  const resumed = await request(host2, 'host:resume', { code, hostKey });
  assert.equal(resumed.ok, true);
  assert.equal(resumed.snapshot.players[0].nickname, 'Вера');
  await new Promise((resolve) => setTimeout(resolve, 400));
  assert.ok(server.rooms.get(code), 'комната жива после переподключения ведущего');

  await request(host2, 'host:start');
  player.disconnect();
  const player2 = await client();
  const rejoined = await request(player2, 'player:rejoin', { code, token: joined.token });
  assert.equal(rejoined.ok, true);
  assert.equal(rejoined.snapshot.state, 'question');
  assert.equal((await request(player2, 'player:answer', { questionIndex: 0, answer: 1 })).ok, true);

  // Удалённый ведущим игрок получает уведомление.
  const kicked = once(player2, 'player:kicked');
  await request(host2, 'host:kick', { playerId: joined.playerId });
  await kicked;

  await request(host2, 'host:close');
  assert.equal(server.rooms.get(code), null);
  host2.disconnect();
  player2.disconnect();
});

test('Socket.IO: в лобби отключившийся игрок исчезает после паузы', async () => {
  const host = await client({ token: token() });
  const { code } = await request(host, 'host:create', { quiz });
  const player = await client();
  await request(player, 'player:join', { code, nickname: 'Гоша', photo: photo() });

  const left = new Promise((resolve) => host.on('lobby:update', (update) => update.action === 'leave' && resolve(update)));
  player.disconnect();
  const update = await left;
  assert.equal(update.count, 0);
  await request(host, 'host:close');
  host.disconnect();
});
