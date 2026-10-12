#!/usr/bin/env node
// Нагрузочный тест: имитирует наплыв игроков из одной Wi-Fi сети (у всех один IP, как в классе или зале).
//
//   npm run loadtest --prefix server                      # 80 игроков против http://localhost:3000
//   node scripts/loadtest.js https://al-studio-xxxx.onrender.com 120
//
// Сценарий: ведущий создаёт комнату → игроки входят (проверка кода, ника, player:join с фото) →
// старт → все отвечают на вопросы → «моргание сети»: все соединения рвутся и восстанавливаются
// одновременно → игра продолжается до финала. В конце — сводка ошибок и задержек.
import { randomBytes } from 'node:crypto';
import { io } from 'socket.io-client';

const SERVER = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const PLAYERS = Number(process.argv[3] || 80);
const QUESTIONS = 3;

const stats = {
  restErrors: {},
  joinErrors: {},
  rejoinErrors: {},
  answerErrors: {},
  unexpectedDisconnects: 0,
  joined: 0,
  rejoined: 0,
  answered: 0,
  latencies: [],
};
const count = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

function photo() {
  // ~12 КБ — как реальное селфи 200×200
  const bytes = randomBytes(12_000);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
}

function connect(auth) {
  return new Promise((resolve, reject) => {
    const socket = io(SERVER, { auth, transports: ['websocket'], forceNew: true, reconnection: false, timeout: 20_000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function emit(socket, event, payload) {
  const started = Date.now();
  try {
    const response = await socket.timeout(15_000).emitWithAck(event, payload);
    stats.latencies.push(Date.now() - started);
    return response;
  } catch {
    return { ok: false, code: 'TIMEOUT' };
  }
}

async function rest(path, body) {
  try {
    const response = await fetch(SERVER + path, {
      method: body ? 'POST' : 'GET',
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
    });
    if (!response.ok) count(stats.restErrors, response.status);
    return response.ok;
  } catch {
    count(stats.restErrors, 'NETWORK');
    return false;
  }
}

const quiz = {
  title: 'Нагрузочный тест',
  questions: Array.from({ length: QUESTIONS }, (_, i) => ({
    type: 'choice',
    text: `Вопрос ${i + 1}?`,
    answers: ['A', 'B', 'C', 'D'],
    correct: i % 4,
    timeLimit: 20,
    readTime: 3,
  })),
};

class Player {
  constructor(index) {
    this.index = index;
    this.nickname = `Игрок ${index + 1}`;
    this.photo = photo();
    this.socket = null;
    this.token = null;
    this.question = null;
  }

  attach(socket) {
    this.socket = socket;
    socket.on('question', (question) => {
      if (question.phase === 'reading') return; // ждём открытия вариантов
      this.question = question;
    });
    socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') stats.unexpectedDisconnects += 1;
    });
  }

  async join(code) {
    await rest(`/api/rooms/${code}`);
    await rest(`/api/rooms/${code}/nickname`, { nickname: this.nickname });
    try {
      this.attach(await connect());
    } catch {
      count(stats.joinErrors, 'CONNECT');
      return false;
    }
    const response = await emit(this.socket, 'player:join', { code, nickname: this.nickname, photo: this.photo });
    if (!response.ok) {
      count(stats.joinErrors, response.code);
      return false;
    }
    this.token = response.token;
    stats.joined += 1;
    return true;
  }

  // «Моргание сети»: соединение рвётся, телефон подключается заново и возвращается в игру по токену.
  async blink(code) {
    this.socket.disconnect();
    try {
      this.attach(await connect());
    } catch {
      count(stats.rejoinErrors, 'CONNECT');
      return;
    }
    const response = await emit(this.socket, 'player:rejoin', { code, token: this.token });
    if (response.ok) stats.rejoined += 1;
    else count(stats.rejoinErrors, response.code);
  }

  async answer(index) {
    for (let i = 0; i < 100 && this.question?.index !== index; i += 1) await sleep(100);
    if (this.question?.index !== index) {
      count(stats.answerErrors, 'NO_QUESTION');
      return;
    }
    const answer = Math.floor(Math.random() * this.question.answers.length);
    const response = await emit(this.socket, 'player:answer', { questionIndex: index, answer });
    if (response.ok) stats.answered += 1;
    else count(stats.answerErrors, response.code);
  }
}

async function main() {
  console.log(`Сервер: ${SERVER}, игроков: ${PLAYERS}`);
  const host = await connect({ token: randomBytes(32).toString('hex') });
  const created = await emit(host, 'host:create', { quiz });
  if (!created.ok) throw new Error(`host:create: ${created.error}`);
  const { code } = created;
  console.log(`Комната ${code}`);

  const players = Array.from({ length: PLAYERS }, (_, i) => new Player(i));
  // Люди приходят волнами в течение нескольких секунд.
  await Promise.all(players.map(async (player, i) => {
    await sleep((i % 20) * 150);
    await player.join(code);
  }));
  const active = players.filter((player) => player.token);
  console.log(`Вошли: ${stats.joined}/${PLAYERS}`);

  const started = await emit(host, 'host:start');
  if (!started.ok) throw new Error(`host:start: ${started.error}`);

  for (let q = 0; q < QUESTIONS; q += 1) {
    if (q === 1) {
      console.log('Моргание сети: все переподключаются одновременно…');
      await Promise.all(active.map((player) => player.blink(code)));
      console.log(`Вернулись в игру: ${stats.rejoined}/${active.length}`);
    }
    const results = new Promise((resolve) => host.once('results', resolve));
    await Promise.all(active.map((player) => player.answer(q)));
    await Promise.race([results, sleep(25_000)]);
    if (q < QUESTIONS - 1) await emit(host, 'host:next');
  }
  await emit(host, 'host:next'); // финал
  await emit(host, 'host:close');

  for (const player of players) player.socket?.disconnect();
  host.disconnect();

  const sorted = [...stats.latencies].sort((a, b) => a - b);
  const p = (q) => sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * q))] ?? 0;
  console.log('\n=== Итог ===');
  console.log(`Вошли в игру:          ${stats.joined}/${PLAYERS}`);
  console.log(`Вернулись после сбоя:  ${stats.rejoined}/${active.length}`);
  console.log(`Ответов принято:       ${stats.answered}/${active.length * QUESTIONS}`);
  console.log(`Ошибки REST:           ${JSON.stringify(stats.restErrors)}`);
  console.log(`Ошибки входа:          ${JSON.stringify(stats.joinErrors)}`);
  console.log(`Ошибки возврата:       ${JSON.stringify(stats.rejoinErrors)}`);
  console.log(`Ошибки ответов:        ${JSON.stringify(stats.answerErrors)}`);
  console.log(`Внезапные обрывы:      ${stats.unexpectedDisconnects}`);
  console.log(`Задержка ответа сервера: p50 ${p(0.5)} мс, p95 ${p(0.95)} мс, max ${sorted.at(-1) ?? 0} мс`);

  const failed = stats.joined < PLAYERS || stats.rejoined < active.length || stats.answered < active.length * QUESTIONS;
  process.exit(failed ? 1 : 0);
}

main().catch((error) => {
  console.error('Ошибка:', error.message);
  process.exit(2);
});
