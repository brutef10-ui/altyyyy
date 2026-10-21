// Сервер квиз-игры «Luminous»: REST API для сохранённых игр + Socket.IO для живой игры.
import http from 'node:http';
import path from 'node:path';
import { promises as fs } from 'node:fs';
import { pathToFileURL } from 'node:url';
import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import { Server } from 'socket.io';

import { loadConfig } from './src/config.js';
import { AppError } from './src/errors.js';
import { deviceOwnerFromRequest, requireOwner } from './src/auth.js';
import { RateLimiter } from './src/rateLimit.js';
import { QuizService } from './src/quizzes.js';
import { IMAGE_TYPES } from './src/images.js';
import { createDb } from './src/db/index.js';
import { migrate } from './src/db/migrate.js';
import { createIdentity } from './src/identity/index.js';
import { authRouter } from './src/routes/auth.js';
import { adminRouter } from './src/admin/routes.js';
import { SharingService } from './src/admin/sharing.js';
import { sharingConfig } from './src/admin/sharingConfig.js';
import { AuditLog } from './src/logs/audit.js';
import { EVENT_TYPES, EventLog } from './src/logs/events.js';
import { Retention } from './src/logs/retention.js';
import { publicBan } from './src/security/bans.js';
import { BackupScheduler } from './src/backup/scheduler.js';
import { storageFromConfig } from './src/backup/storage.js';
import { ipFromSocket } from './src/identity/clientIp.js';
import { PgQuizStore } from './src/stores/pgQuizStore.js';
import { PgImageStore } from './src/stores/pgImageStore.js';
import { LegacyService, importLegacyData } from './src/stores/legacy.js';
import { RoomManager } from './src/rooms.js';
import { registerSocketHandlers } from './src/sockets.js';
import { MAX_PHOTO_BYTES, QUIZ_LIMITS, quizImageIds, validateNickname, validateRoomCode } from './src/validate.js';

// Фото до 100 КБ в base64 занимает ~137 КБ, игра на 50 вопросов — до ~100 КБ.
const SOCKET_MAX_MESSAGE_BYTES = 256 * 1024;

// Страницы сайта ведущего, которые доступны только после входа (создание и запуск игр, включая демо).
const HOST_PAGES = new Set(['/', '/index.html', '/editor.html', '/lobby.html', '/game.html', '/results.html', '/account.html']);

// Режим SERVE_SITES: оба сайта отдаёт сам сервер, поэтому адрес сервера для них — тот же, что у страницы.
function mountSites(app, config) {
  const hostDir = path.join(config.sitesRoot, 'host-site');
  const playerDir = path.join(config.sitesRoot, 'player-site');

  // Без входа страницы ведущего не отдаём — сразу на страницу входа (данные защищены и на уровне API).
  app.use('/host', (req, res, next) => {
    // Заблокированному — тоже на страницу входа: она покажет причину и срок блокировки.
    if ((req.method === 'GET' || req.method === 'HEAD') && HOST_PAGES.has(req.path) && (!req.identity?.account || req.identity.ban)) {
      res.set('Cache-Control', 'no-store');
      res.redirect(302, `/host/login.html?next=${encodeURIComponent(req.originalUrl)}`);
      return;
    }
    next();
  });

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

// Админ-консоль: сервер отдаёт её файлы (HTML, скрипты, стили) только администратору.
// Гостя — на страницу входа, остальным — 403. Данные консоли — отдельно, в /api/admin/* с той же проверкой.
function mountAdmin(app, config) {
  const adminDir = path.join(config.sitesRoot, 'admin-site');
  app.use('/admin', (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    const account = req.identity?.account;
    if (!account) {
      if (req.method === 'GET' && (req.path === '/' || req.path === '/index.html')) {
        const login = config.serveSites ? '/host/login.html' : `${config.hostOrigins[0]}/login.html`;
        res.redirect(302, config.serveSites ? `${login}?next=${encodeURIComponent('/admin/')}` : login);
      } else {
        res.status(401).type('text/plain; charset=utf-8').send('Войдите в аккаунт администратора.');
      }
      return;
    }
    if (account.role !== 'admin') {
      res.status(403).type('text/html; charset=utf-8').send('<!doctype html><meta charset="utf-8"><title>Нет доступа</title><p>Недостаточно прав.</p>');
      return;
    }
    next();
  }, express.static(adminDir, { index: 'index.html' }));
}

function isSameOrigin(origin, host) {
  try {
    return new URL(origin).host === host;
  } catch {
    return false;
  }
}

// Запросы, которым нужна личность (посетитель, сессия): страницы сайта и API, кроме картинок.
function needsIdentity(req) {
  if (req.path.startsWith('/api/')) return !(req.method === 'GET' && req.path.startsWith('/api/images/'));
  if (req.path === '/admin' || req.path.startsWith('/admin/')) return true;
  // Страницы: «…/», «….html» и адреса без расширения (например, /host до перенаправления на /host/).
  return (req.method === 'GET' || req.method === 'HEAD') && (req.path.endsWith('.html') || !/\.[A-Za-z0-9]+$/.test(req.path));
}

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([promise, new Promise((resolve, reject) => {
    timer = setTimeout(() => reject(new Error('timeout')), ms);
  })]).finally(() => clearTimeout(timer));
}

function createApp({ config, db, identity, audit, events, sharing, backups, legacy, quizService, images, rooms, roomLimiter }) {
  const app = express();
  app.disable('x-powered-by');
  // Express узнаёт HTTPS (для Secure-cookie) из X-Forwarded-Proto только от доверенных прокси.
  if (config.trustProxyHops > 0) app.set('trust proxy', config.trustProxyHops);
  else if (config.trustProxy) app.set('trust proxy', config.trustProxy);

  // Заголовки безопасности. CSP: скрипты только с нашего сайта (без встроенных и eval), стили — свои и
  // Google Fonts, картинки — свои, data: (фото игроков) и blob: (превью), соединения — только с этим сервером
  // (HTTP и WebSocket), сайт нельзя встроить во фрейм.
  const sameHostSockets = (req) => {
    const host = String(req.get('host') || '').replace(/[^A-Za-z0-9.:[\]-]/g, '');
    return host ? `${req.secure ? 'wss' : 'ws'}://${host}` : "'self'";
  };
  app.use(helmet({
    contentSecurityPolicy: {
      useDefaults: false,
      directives: {
        defaultSrc: ["'self'"],
        scriptSrc: ["'self'"],
        styleSrc: ["'self'", 'https://fonts.googleapis.com'],
        fontSrc: ["'self'", 'https://fonts.gstatic.com'],
        imgSrc: ["'self'", 'data:', 'blob:'],
        mediaSrc: ["'self'", 'blob:'],
        connectSrc: ["'self'", sameHostSockets],
        objectSrc: ["'none'"],
        baseUri: ["'self'"],
        formAction: ["'self'"],
        frameAncestors: ["'none'"],
        ...(config.production ? { upgradeInsecureRequests: [] } : {}),
      },
    },
    crossOriginEmbedderPolicy: false,
    crossOriginResourcePolicy: { policy: 'same-site' },
    frameguard: { action: 'deny' },
    referrerPolicy: { policy: 'no-referrer' },
  }));

  // CORS: игры доступны только сайту ведущего, проверка комнаты — обоим сайтам.
  // credentials — чтобы сайт с другого адреса (локальная разработка) мог отправлять cookie сессии.
  const corsBase = { methods: ['GET', 'POST', 'PUT', 'DELETE'], allowedHeaders: ['Content-Type', 'Authorization', 'X-CSRF-Token'], credentials: true, maxAge: 600 };
  const hostCors = cors({ ...corsBase, origin: config.hostOrigins });
  const anyCors = cors({ ...corsBase, origin: config.allOrigins });

  const identify = identity.http();
  app.use((req, res, next) => (needsIdentity(req) ? identify(req, res, next) : next()));

  if (config.serveSites) mountSites(app, config);
  mountAdmin(app, config);

  app.get('/', (req, res) => res.json({ name: 'Luminous — сервер квиз-игры', status: 'ok' }));
  app.get('/health', async (req, res) => {
    let database = 'ok';
    try {
      await withTimeout(db.ping(), 2_000);
    } catch {
      database = 'error';
    }
    res.set('Cache-Control', 'no-store');
    res.json({ status: database === 'ok' ? 'ok' : 'degraded', db: database, rooms: rooms.size, uptime: Math.round(process.uptime()) });
  });

  app.get('/api/config', anyCors, (req, res) => {
    res.set('Cache-Control', 'no-store');
    res.json({ playerSiteUrl: config.playerSiteUrl, hostSiteUrl: config.hostSiteUrl, limits: QUIZ_LIMITS, maxPhotoBytes: MAX_PHOTO_BYTES, imageTypes: IMAGE_TYPES });
  });

  // ---------- Картинки к вопросам ----------
  // Загружает только ведущий; смотрят все (картинка показывается на проекторе и на телефонах).
  app.post('/api/images', hostCors, requireOwner, identity.rejectBanned, identity.csrf, express.raw({ type: IMAGE_TYPES, limit: QUIZ_LIMITS.imageMaxBytes }), async (req, res) => {
    const type = String(req.get('content-type') || '').split(';')[0].trim().toLowerCase();
    if (!Buffer.isBuffer(req.body)) throw new AppError('Картинка должна быть в формате JPEG, PNG или WebP', { status: 415, code: 'BAD_IMAGE' });
    const image = await images.save(req.owner.id, req.body, type);
    res.status(201).json({ id: image.id, url: `/api/images/${image.id}` });
  });
  app.options('/api/images', hostCors);

  app.get('/api/images/:id', async (req, res) => {
    const image = await images.read(req.params.id);
    if (!image) {
      res.status(404).json({ error: 'Картинка не найдена', code: 'NOT_FOUND' });
      return;
    }
    res.set({
      'Content-Type': image.type,
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Cross-Origin-Resource-Policy': 'cross-origin',
    });
    res.send(image.bytes);
  });

  // ---------- Вход и аккаунт ----------
  app.use('/api/auth', anyCors, authRouter({ identity, config, events }));

  // ---------- Администратор ----------
  app.use('/api/admin', hostCors, adminRouter({ db, identity, audit, config, sharing, backups }));

  // ---------- Перенос игр, созданных до появления аккаунтов ----------
  // Нужны и сессия (куда переносить), и старый токен браузера в Authorization (откуда).
  const legacyApi = express.Router();
  legacyApi.use(requireOwner, identity.rejectBanned, identity.csrf, (req, res, next) => {
    res.set('Cache-Control', 'no-store');
    req.deviceOwner = deviceOwnerFromRequest(req);
    next();
  });
  legacyApi.get('/', async (req, res) => {
    res.json({ count: req.deviceOwner ? await legacy.count(req.deviceOwner.id) : 0 });
  });
  legacyApi.post('/claim', async (req, res) => {
    res.json({ claimed: req.deviceOwner ? await legacy.claim(req.deviceOwner.id, req.owner.id) : 0 });
  });
  app.use('/api/legacy', hostCors, legacyApi);

  // ---------- Сохранённые игры (только ведущий) ----------
  const quizzesApi = express.Router();
  quizzesApi.use(express.json({ limit: '256kb' }), requireOwner, identity.rejectBanned, identity.csrf, (req, res, next) => {
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
    const quiz = await quizService.create(req.owner.id, req.body);
    events.record(EVENT_TYPES.quizCreate, req.identity, { details: { quizId: quiz.id, title: quiz.title } });
    res.status(201).json({ quiz });
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
  // Считаются только неверные коды: игроки одной Wi-Fi сети приходят с одного IP, и это нормально.
  roomsApi.use(roomLimiter.failuresMiddleware('Слишком много попыток с неверным кодом. Подождите минуту.'), identity.rejectBanned, express.json({ limit: '2kb' }), (req, res, next) => {
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
      const isImage = req.path.startsWith('/api/images');
      res.status(413).json({ error: isImage ? 'Картинка больше 1 МБ' : 'Слишком большой запрос', code: 'TOO_LARGE' });
      return;
    }
    console.error('[http]', error);
    res.status(500).json({ error: 'Внутренняя ошибка сервера', code: 'INTERNAL' });
  });

  return app;
}

// База могла ещё не проснуться (деплой, перезапуск БД) — несколько попыток перед отказом.
async function connectDb(db, attempts) {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await db.ping();
      return;
    } catch (error) {
      if (attempt >= attempts) throw new Error(`Нет связи с базой данных: ${error.message}`);
      console.warn(`[db] нет связи (${error.message}), попытка ${attempt}/${attempts}…`);
      await new Promise((resolve) => setTimeout(resolve, 3_000));
    }
  }
}

export async function startServer(overrides = {}) {
  const { db: providedDb, ...configOverrides } = overrides;
  const config = loadConfig(configOverrides);
  // Обязательные настройки проверяем до подключения к БД.
  if (config.production && (!config.sessionSecret || config.sessionSecret.length < 32)) {
    throw new Error('SESSION_SECRET не задан или короче 32 символов (см. .env.example).');
  }

  const db = providedDb ?? createDb({ url: config.databaseUrl, ssl: config.databaseSsl, schema: config.databaseSchema || undefined });
  const ownsDb = !providedDb;
  await connectDb(db, config.dbConnectAttempts ?? 10);
  await migrate(db, { log: config.quiet ? null : console.log });

  const identity = createIdentity({ db, config });
  const admin = await identity.accounts.ensureAdmin({ login: config.adminLogin, passwordHash: config.adminPasswordHash }, identity.sessions);
  if (!config.quiet && admin.status !== 'ok') console.log(`[admin] вход администратора: ${admin.status}`);
  try {
    await importLegacyData(db, { dataFile: config.dataFile, imagesDir: config.imagesDir, maxImageBytes: QUIZ_LIMITS.imageMaxBytes, log: config.quiet ? null : console.log });
  } catch (error) {
    console.error('[db] перенос старых игр не удался:', error.message);
  }
  const legacy = new LegacyService(db);
  const audit = new AuditLog(db);
  const events = new EventLog(db);
  const sharing = new SharingService(db, { config: config.sharing ?? sharingConfig(), timeZone: config.sharingTimeZone });
  await identity.bans.load();
  identity.bans.start();

  const store = new PgQuizStore(db);
  const images = new PgImageStore(db, { maxBytes: QUIZ_LIMITS.imageMaxBytes, quotaBytes: config.imageQuotaMb * 1024 * 1024 });
  const quizService = new QuizService(store, { images });
  const rooms = new RoomManager({ maxRooms: config.maxRooms, maxPlayersPerRoom: config.maxPlayersPerRoom });
  const roomLimiter = new RateLimiter({ windowMs: 60_000, max: 30 });

  // Уборка картинок, которые не нужны ни сохранённым играм, ни идущим сейчас комнатам.
  const collectImages = async () => {
    try {
      const referenced = await quizService.referencedImageIds();
      for (const room of rooms.all()) quizImageIds(room.quiz).forEach((id) => referenced.add(id));
      await images.collectGarbage(referenced, config.imageGcMinAgeMs);
    } catch (error) {
      console.error('[images] уборка не удалась:', error.message);
    }
  };
  const imageGc = setInterval(collectImages, config.imageGcIntervalMs);
  imageGc.unref();
  collectImages();

  // Уборка старых счётчиков попыток и истёкших сессий — лёгкие запросы раз в час.
  const maintenance = setInterval(() => {
    identity.throttle.cleanup().catch((error) => console.error('[db] уборка лимитов:', error.message));
    identity.sessions.cleanup().catch((error) => console.error('[db] уборка сессий:', error.message));
  }, 60 * 60_000);
  maintenance.unref();

  // Сроки хранения журналов: раз в сутки (первый раз — через минуту после старта).
  const retention = new Retention(db, config);
  const runRetention = () => retention.run()
    .then((result) => {
      const changed = Object.entries(result).filter(([, count]) => count > 0);
      if (changed.length && !config.quiet) console.log('[retention]', Object.fromEntries(changed));
    })
    .catch((error) => console.error('[retention] не удалось:', error.message));
  const retentionFirst = setTimeout(runRetention, 60_000);
  retentionFirst.unref();
  const retentionTimer = setInterval(runRetention, 24 * 60 * 60_000);
  retentionTimer.unref();

  // Резервные копии: раз в BACKUP_INTERVAL_HOURS, если заданы ключ шифрования и хранилище.
  let backups = null;
  const backupStorage = storageFromConfig(config);
  if (config.backup.encryptionKey && backupStorage) {
    try {
      backups = new BackupScheduler({ db, storage: backupStorage, encryptionKey: config.backup.encryptionKey, intervalHours: config.backup.intervalHours, keep: config.backup.keep });
      if (config.backupSchedule !== false) backups.start();
    } catch (error) {
      console.error(`[backup] выключены: ${error.message}`);
    }
  } else if (config.production) {
    console.warn('[backup] выключены: задайте BACKUP_ENCRYPTION_KEY и GOOGLE_DRIVE_* (см. .env.example и docs/DEPLOY.md).');
  }

  const app = createApp({ config, db, identity, audit, events, sharing, backups, legacy, quizService, images, rooms, roomLimiter });
  const server = http.createServer(app);
  const io = new Server(server, {
    cors: { origin: config.allOrigins, methods: ['GET', 'POST'], credentials: true },
    maxHttpBufferSize: SOCKET_MAX_MESSAGE_BYTES,
    // Телефоны засыпают, переключаются между Wi-Fi и мобильной сетью, а бесплатный хостинг
    // может «задуматься» на пару секунд. Слишком строгие пинги рвали такие соединения,
    // поэтому используем мягкие значения (стандартные для Socket.IO).
    pingInterval: 25_000,
    pingTimeout: 20_000,
    // WebSocket не подчиняется CORS, поэтому Origin проверяем сами: разрешены сайты из .env
    // и страницы, которые отдал сам сервер (SERVE_SITES). Запросы без Origin (не из браузера,
    // например тесты) пропускаем: права проверяются на уровне событий.
    allowRequest: (req, callback) => {
      const origin = req.headers.origin;
      callback(null, !origin || config.allOrigins.includes(origin) || isSameOrigin(origin, req.headers.host));
    },
  });
  // Личность подключения (посетитель, сессия, аккаунт) — по cookie из handshake.
  // Если БД недоступна, игрок всё равно может играть: подключение остаётся анонимным.
  io.use(async (socket, next) => {
    try {
      socket.identity = await identity.fromHandshake(socket);
    } catch (error) {
      console.error('[socket] не удалось определить сессию:', error.message);
      socket.identity = { ip: ipFromSocket(socket, config), userAgent: socket.handshake.headers['user-agent'] || null, visitorId: null, session: null, account: null, sessionToken: null };
      socket.identity.ban = identity.banFor(socket.identity);
    }
    // Заблокированных не пускаем: клиент получит connect_error с data.code = 'BANNED' и покажет экран блокировки.
    if (socket.identity.ban) {
      const error = new Error('Вы заблокированы');
      error.data = { code: 'BANNED', ban: { ...publicBan(socket.identity.ban), contact: config.adminContact || null } };
      next(error);
      return;
    }
    next();
  });
  const sockets = registerSocketHandlers(io, { rooms, quizService, images, config, identity, events });
  // Новая блокировка действует сразу: заблокированные выходят из идущих игр.
  identity.bans.onChange(() => sockets.enforceBans());

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
    db,
    identity,
    sharing,
    port,
    url: `http://localhost:${port}`,
    close() {
      closing ??= (async () => {
        sockets.closeAll('shutdown');
        sockets.stop();
        roomLimiter.stop();
        identity.stop();
        clearInterval(imageGc);
        clearInterval(maintenance);
        clearInterval(retentionTimer);
        backups?.stop();
        clearTimeout(retentionFirst);
        await new Promise((resolve) => io.close(() => resolve()));
        if (ownsDb) await db.close();
      })();
      return closing;
    },
  };
}

const isMain = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;

if (isMain) {
  let instance;
  try {
    instance = await startServer();
  } catch (error) {
    console.error(`Luminous: сервер не запущен. ${error.message}`);
    process.exit(1);
  }
  const { config } = instance;
  console.log(`Luminous: сервер запущен на порту ${instance.port}`);
  if (config.serveSites) {
    console.log(`  Сайт ведущего: http://localhost:${instance.port}/host/`);
    console.log(`  Сайт игрока:   http://localhost:${instance.port}/`);
  } else {
    console.log(`  Сайт ведущего: ${config.hostOrigins.join(', ')}`);
    console.log(`  Сайт игрока:   ${config.playerOrigins.join(', ')}`);
  }
  console.log('  Данные игр:    PostgreSQL (DATABASE_URL)');

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
