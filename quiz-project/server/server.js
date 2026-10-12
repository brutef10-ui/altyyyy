// Сервер квиз-игры «AL Studio»: REST API для сохранённых игр + Socket.IO для живой игры.
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import { Server } from 'socket.io';

import { loadConfig } from './src/config.js';
import { AppError } from './src/errors.js';
import { requireOwner } from './src/auth.js';
import { RateLimiter } from './src/rateLimit.js';
import { JsonQuizStore, QuizService } from './src/quizzes.js';
import { RoomManager } from './src/rooms.js';
import { registerSocketHandlers } from './src/sockets.js';
import { MAX_PHOTO_BYTES, QUIZ_LIMITS, validateNickname, validateRoomCode } from './src/validate.js';

// Фото до 100 КБ в base64 занимает ~137 КБ, игра на 50 вопросов — до ~100 КБ.
const SOCKET_MAX_MESSAGE_BYTES = 256 * 1024;

// Режим SERVE_SITES: оба сайта отдаёт сам сервер, поэтому адрес сервера для них — тот же, что у страницы.
function mountSites(app, config) {
  const hostDir = path.join(config.sitesRoot, 'host-site');
  const playerDir = path.join(config.sitesRoot, 'player-site');

  const sameOriginConfig = (dir) => async (req, res) => {
    const source = await fs.readFile(path.join(dir, 'js', 'config.js'), 'utf8');
    res.type('text/javascript').set('Cache-Control', 'no-cache')
      .send(source.replace("const PRODUCTION_SERVER_URL = '';", 'const PRODUCTION_SERVER_URL = window.location.origin;'));
  };

  app.get('/host/js/config.js', sameOriginConfig(hostDir));
  app.get('/js/config.js', sameOriginConfig(playerDir));
  app.use('/host', express.static(hostDir));
  app.use(express.static(playerDir));
}

function isSameOrigin(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

function createApp({ config, quizService, rooms, roomLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  app.use((req, res, next) => {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('X-Frame-Options', 'DENY');
    next();
  });

  // CORS: игры доступны только сайту ведущего, проверка комнаты — обоим сайтам.
  const corsBase = { methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization'], maxAge: 600 };
  const hostCors = cors({ ...corsBase, origin: config.hostOrigins });
  const anyCors = cors({ ...corsBase, origin: config.allOrigins });

  if (config.serveSites) mountSites(app, config);

  app.get('/', (req, res) => res.json({ name: 'AL Studio — сервер квиз-игры', status: 'ok' }));
  app.get('/health', (req, res) => res.json({ status: 'ok', rooms: rooms.size, uptime: Math.round(process.uptime()) }));

  app.get('/api/config', anyCors, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ playerSiteUrl: config.playerSiteUrl, limits: QUIZ_LIMITS, maxPhotoBytes: MAX_PHOTO_BYTES });
  });

  // ---------- Сохранённые игры (только ведущий) ----------
  const quizzesApi = express.Router();
  quizzesApi.use(express.json({ limit: '256kb' }), requireOwner, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });
  quizzesApi.get('/', async (req, res) => {
    res.json({ quizzes: await quizService.list(req.owner.id) });
  });
  quizzesApi.get('/:id', async (req, res) => {
    res.json({ quiz: await quizService.get(req.owner.id, req.params.id) });
  });
  quizzesApi.post('/', async (req, res) => {
    res.status(201).json({ quiz: await quizService.create(req.owner.id, req.body) });
  });
  quizzesApi.put('/:id', async (req, res) => {
    res.json({ quiz: await quizService.update(req.owner.id, req.params.id, req.body) });
  });
  quizzesApi.delete('/:id', async (req, res) => {
    await quizService.remove(req.owner.id, req.params.id);
    res.status(204).end();
  });
  app.use('/api/quizzes', hostCors, quizzesApi);

  // ---------- Проверки для игрока перед входом ----------
  const roomsApi = express.Router();
  roomsApi.use(roomLimiter.middleware('Слишком много попыток. Подождите минуту.'), express.json({ limit: '2kb' }), (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    next();
  });

  function joinableRoom(rawCode) {
    const code = validateRoomCode(rawCode);
    if (!code.ok) throw new AppError(code.error, { code: 'BAD_CODE' });
    const room = rooms.get(code.value);
    if (!room || room.closed) throw new AppError('Комната не найдена. Проверьте код.', { status: 404, code: 'ROOM_NOT_FOUND' });
    if (!room.isJoinable) throw new AppError('Игра уже началась — войти нельзя', { status: 409, code: 'GAME_STARTED' });
    if (room.players.isFull) throw new AppError('Комната заполнена', { status: 409, code: 'ROOM_FULL' });
    return room;
  }

  roomsApi.get('/:code', (req, res) => {
    const room = joinableRoom(req.params.code);
    res.json({ code: room.code, title: room.quiz.title, playerCount: room.players.size });
  });

  // Предварительная проверка ника. Окончательная — при player:join.
  roomsApi.post('/:code/nickname', (req, res) => {
    const room = joinableRoom(req.params.code);
    const nickname = validateNickname(req.body?.nickname);
    if (!nickname.ok) throw new AppError(nickname.error, { code: 'BAD_NICKNAME' });
    if (room.players.isNicknameTaken(nickname.value)) {
      throw new AppError('Этот ник уже занят в комнате. Выберите другой.', { status: 409, code: 'NICKNAME_TAKEN' });
    }
    res.json({ nickname: nickname.value });
  });
  app.use('/api/rooms', anyCors, roomsApi);

  // ---------- Ошибки ----------
  app.use('/api', (req, res) => res.status(404).json({ error: 'Не найдено', code: 'NOT_FOUND' }));

  // eslint-disable-next-line no-unused-vars
  app.use((error, req, res, next) => {
    if (error instanceof AppError) {
      res.status(error.status).json({ error: error.message, code: error.code, details: error.details });
      return;
    }
    if (error.type === 'entity.parse.failed') {
      res.status(400).json({ error: 'Некорректный JSON', code: 'BAD_JSON' });
      return;
    }
    if (error.type === 'entity.too.large') {
      res.status(413).json({ error: 'Слишком большой запрос', code: 'TOO_LARGE' });
      return;
    }
    console.error('[http]', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'INTERNAL' });
  });

  return app;
}

export async function startServer(overrides = {}) {
  const config = loadConfig(overrides);

  const store = new JsonQuizStore(config.dataFile);
  await store.init();
  const quizService = new QuizService(store);
  const rooms = new RoomManager({ maxRooms: config.maxRooms, maxPlayersPerRoom: config.maxPlayersPerRoom });
  const roomLimiter = new RateLimiter({ windowMs: 60_000, max: 60 });

  const app = createApp({ config, quizService, rooms, roomLimiter });
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.allOrigins, methods: ['GET', 'POST'] },
    maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,
    pingInterval: 10_000,
    pingTimeout: 8_000,
    // WebSocket не подчиняется CORS, поэтому Origin проверяем сами: разрешены сайты из .env
    // и страницы, которые отдал сам сервер (SERVE_SITES). Запросы без Origin (не из браузера,
    // например тесты) пропускаем: права проверяются на уровне событий.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || config.allOrigins.includes(origin) || isSameOrigin(origin, req.headers.host));
    },
  });
  const sockets = registerSocketHandlers(io, { rooms, quizService, config });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(config.port, resolve);
  });

  const { port } = server.address();
  let closing = null;

  return {
    app,
    io,
    server,
    rooms,
    config,
    port,
    url: `http://localhost:${port}`,
    close() {
      closing ??= (async () => {
        sockets.closeAll('shutdown');
        sockets.stop();
        roomLimiter.stop();
        await new Promise((resolve) => io.close(() => resolve()));
      })();
      return closing;
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  const instance = await startServer();
  const { config } = instance;
  console.log(`AL Studio: сервер запущен на порту ${instance.port}`);
  if (config.serveSites) {
    console.log(`  Сайт ведущего: http://localhost:${instance.port}/host/`);
    console.log(`  Сайт игрока:   http://localhost:${instance.port}/`);
  } else {
    console.log(`  Сайт ведущего: ${config.hostOrigins.join(', ')}`);
    console.log(`  Сайт игрока:   ${config.playerOrigins.join(', ')}`);
  }
  console.log(`  Данные игр:    ${config.dataFile}`);

  const shutdown = async (signal) => {
    console.log(`\n${signal}: останавливаю сервер…`);
    const force = setTimeout(() => process.exit(1), 5_000);
    force.unref();
    await instance.close();
    process.exit(0);
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}
