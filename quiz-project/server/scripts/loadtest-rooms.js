#!/usr/bin/env node
// Нагрузочный тест «много игр сразу»: N комнат одновременно, у каждой свой ведущий и свои игроки.
//
//   node scripts/loadtest-rooms.js http://localhost:3000 50 40      # 50 комнат по 40 игроков = 2000 человек
//
// Что имитируется:
//   * «весь мир»: у каждого ведущего и игрока свой IP (заголовок X-Forwarded-For) и своя «задержка сети»
//     от 30 до 300 мс перед каждой отправкой; чтобы сервер учитывал IP из заголовка, задайте на нём
//     TRUST_PROXY_HOPS=1, а регистрации с «одного» IP не ограничивайте (REGISTRATIONS_PER_IP_PER_HOUR=1000
//     и REGISTRATIONS_PER_HOUR=10000);
//   * люди отвечают не одновременно, а через 1–8 секунд после появления вопроса;
//   * на каждый вопрос все комнаты работают одновременно.
// В конце — сводка: сколько вошло и ответило, задержки раздачи вопроса и результатов, ошибки.
import { randomBytes, randomInt } from 'node:crypto';
import { io } from 'socket.io-client';

const SERVER = (process.argv[2] || 'http://localhost:3000').replace(/\/+$/, '');
const ROOMS = Number(process.argv[3] || 10);
const PER_ROOM = Number(process.argv[4] || 40);
const QUESTIONS = 3;

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const stats = { joined: 0, rejoinErrors: {}, joinErrors: {}, answerErrors: {}, answered: 0, hostErrors: {}, drops: 0, ack: [], questionFanout: [], resultsFanout: [] };
const count = (bucket, key) => { bucket[key] = (bucket[key] || 0) + 1; };

// «Регионы»: начало IP и типичная задержка (мс) — Москва, Европа, США, Азия, Австралия.
const REGIONS = [[95, 40], [85, 60], [73, 150], [111, 220], [101, 300]];
const randomIp = () => {
  const [first] = REGIONS[randomInt(REGIONS.length)];
  return `${first}.${randomInt(256)}.${randomInt(256)}.${randomInt(1, 255)}`;
};
const rttFor = (ip) => {
  const region = REGIONS.find(([first]) => String(first) === ip.split('.')[0]);
  return (region?.[1] ?? 100) / 2 + randomInt(0, 40);
};

const photo = () => {
  const bytes = randomBytes(12_000);
  bytes.set([0xff, 0xd8, 0xff, 0xe0]);
  return `data:image/jpeg;base64,${bytes.toString('base64')}`;
};

const quiz = {
  title: 'Нагрузка: много комнат',
  questions: Array.from({ length: QUESTIONS }, (_, i) => ({
    type: 'choice', text: `Вопрос ${i + 1}?`, answers: ['A', 'B', 'C', 'D'], correct: i % 4, timeLimit: 30, readTime: 0,
  })),
};

function connect(ip, cookie) {
  return new Promise((resolve, reject) => {
    const extraHeaders = { 'X-Forwarded-For': ip, 'User-Agent': 'Mozilla/5.0 (Linux; Android 14) Chrome/129 Mobile Safari/537.36' };
    if (cookie) extraHeaders.Cookie = cookie;
    const socket = io(SERVER, { transports: ['websocket'], extraHeaders, forceNew: true, reconnection: false, timeout: 30_000 });
    socket.once('connect', () => resolve(socket));
    socket.once('connect_error', reject);
  });
}

async function emit(socket, rtt, event, payload) {
  await sleep(rtt);
  const started = Date.now();
  try {
    const response = await socket.timeout(30_000).emitWithAck(event, payload);
    stats.ack.push(Date.now() - started + rtt);
    return response;
  } catch {
    return { ok: false, code: 'TIMEOUT' };
  }
}

async function hostSession(ip) {
  const jar = new Map();
  const headers = (extra = {}) => ({ 'X-Forwarded-For': ip, Origin: SERVER, Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '), ...extra });
  const call = async (path, body, csrf) => {
    const response = await fetch(SERVER + path, {
      method: body ? 'POST' : 'GET',
      headers: headers({ ...(body ? { 'Content-Type': 'application/json' } : {}), ...(csrf ? { 'X-CSRF-Token': csrf } : {}) }),
      body: body ? JSON.stringify(body) : undefined,
    });
    for (const line of response.headers.getSetCookie()) {
      const [pair] = line.split(';');
      const i = pair.indexOf('=');
      jar.set(pair.slice(0, i), pair.slice(i + 1));
    }
    const data = await response.json().catch(() => null);
    if (!response.ok) throw new Error(`${path}: ${data?.error || response.status}`);
    return data;
  };
  const { csrfToken } = await call('/api/auth/session');
  await call('/api/auth/register', { login: `room${randomBytes(5).toString('hex')}`, password: randomBytes(12).toString('hex') }, csrfToken);
  return [...jar].map(([k, v]) => `${k}=${v}`).join('; ');
}

async function runRoom(roomIndex) {
  await sleep(roomIndex * 80); // ведущие заходят не в одну миллисекунду
  const hostIp = randomIp();
  const hostRtt = rttFor(hostIp);
  let host;
  let code;
  try {
    host = await connect(hostIp, await hostSession(hostIp));
    const created = await emit(host, hostRtt, 'host:create', { quiz });
    if (!created.ok) throw new Error(created.code || created.error);
    code = created.code;
  } catch (error) {
    count(stats.hostErrors, String(error.message).slice(0, 60));
    return;
  }

  const room = { lastAnswerAt: 0, questionSentAt: 0 };
  const players = Array.from({ length: PER_ROOM }, (_, i) => ({ nick: `Игрок ${roomIndex + 1}-${i + 1}`, ip: randomIp(), question: null, token: null, socket: null }));

  await Promise.all(players.map(async (player, i) => {
    await sleep((i % 25) * 120);
    player.rtt = rttFor(player.ip);
    try {
      player.socket = await connect(player.ip);
    } catch {
      count(stats.joinErrors, 'CONNECT');
      return;
    }
    player.socket.on('question', (question) => {
      if (question.phase === 'reading') return;
      if (room.questionSentAt) stats.questionFanout.push(Date.now() - room.questionSentAt);
      player.question = question;
    });
    player.socket.on('results', () => {
      if (room.lastAnswerAt) stats.resultsFanout.push(Math.max(0, Date.now() - room.lastAnswerAt));
    });
    player.socket.on('disconnect', (reason) => {
      if (reason !== 'io client disconnect') stats.drops += 1;
    });
    const response = await emit(player.socket, player.rtt, 'player:join', { code, nickname: player.nick, photo: photo() });
    if (response.ok) {
      player.token = response.token;
      stats.joined += 1;
    } else {
      count(stats.joinErrors, response.code);
    }
  }));
  const active = players.filter((player) => player.token);

  room.questionSentAt = Date.now() + hostRtt; // момент, когда команда реально уйдёт на сервер
  const started = await emit(host, hostRtt, 'host:start');
  if (!started.ok) count(stats.hostErrors, `start:${started.code}`);

  for (let q = 0; q < QUESTIONS; q += 1) {
    const results = new Promise((resolve) => host.once('results', resolve));
    await Promise.all(active.map(async (player) => {
      for (let i = 0; i < 300 && player.question?.index !== q; i += 1) await sleep(100);
      if (player.question?.index !== q) {
        count(stats.answerErrors, 'NO_QUESTION');
        return;
      }
      await sleep(randomInt(1_000, 8_000)); // человек думает
      const answer = randomInt(player.question.answers.length);
      const response = await emit(player.socket, player.rtt, 'player:answer', { questionIndex: q, answer });
      room.lastAnswerAt = Date.now();
      if (response.ok) stats.answered += 1;
      else count(stats.answerErrors, response.code);
    }));
    await Promise.race([results, sleep(35_000)]);
    room.questionSentAt = Date.now() + hostRtt;
    await emit(host, hostRtt, 'host:next');
  }
  await emit(host, hostRtt, 'host:close');
  for (const player of players) player.socket?.disconnect();
  host.disconnect();
}

async function main() {
  console.log(`Сервер: ${SERVER}; комнат одновременно: ${ROOMS}; игроков в комнате: ${PER_ROOM}; всего игроков: ${ROOMS * PER_ROOM}`);
  const started = Date.now();
  await Promise.all(Array.from({ length: ROOMS }, (_, i) => runRoom(i)));
  const sorted = (list) => [...list].sort((a, b) => a - b);
  const q = (list, p) => sorted(list)[Math.min(list.length - 1, Math.floor(list.length * p))] ?? 0;
  const line = (name, list) => console.log(`${name}: p50 ${q(list, 0.5)} мс, p95 ${q(list, 0.95)} мс, max ${sorted(list).at(-1) ?? 0} мс`);
  console.log('\n=== Итог ===');
  console.log(`Время теста:                ${Math.round((Date.now() - started) / 1000)} с`);
  console.log(`Вошли в игру:               ${stats.joined}/${ROOMS * PER_ROOM}`);
  console.log(`Ответов принято:            ${stats.answered}/${stats.joined * QUESTIONS}`);
  console.log(`Ошибки ведущих:             ${JSON.stringify(stats.hostErrors)}`);
  console.log(`Ошибки входа:               ${JSON.stringify(stats.joinErrors)}`);
  console.log(`Ошибки ответов:             ${JSON.stringify(stats.answerErrors)}`);
  console.log(`Внезапные обрывы:           ${stats.drops}`);
  line('Ответ сервера на запрос     ', stats.ack);
  line('Раздача вопроса игрокам     ', stats.questionFanout);
  line('Раздача результатов игрокам ', stats.resultsFanout);
  process.exit(stats.joined === ROOMS * PER_ROOM && stats.answered === stats.joined * QUESTIONS ? 0 : 1);
}

main().catch((error) => {
  console.error('Ошибка:', error.message);
  process.exit(2);
});
