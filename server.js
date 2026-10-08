import express from 'express';
import { createServer } from 'node:http';
import { Server } from 'socket.io';
import multer from 'multer';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.dirname(fileURLToPath(import.meta.url));
const storage = path.join(root, 'data');
const temp = path.join(storage, 'tmp');
await fs.mkdir(temp, { recursive: true });
const app = express();
const server = createServer(app);
const io = new Server(server, { maxHttpBufferSize: 16384 });
const rooms = new Map();
const upload = multer({ dest: temp, limits: { fileSize: 40 * 1024 * 1024, files: 12, fields: 2, fieldSize: 256 } });
const asyncRoute = (handler) => (req, res, next) => Promise.resolve(handler(req, res, next)).catch(next);
const ownerHash = (key) => createHash('sha256').update(key).digest('hex');
const validKey = (key) => typeof key === 'string' && /^[a-f0-9]{64}$/.test(key);
const validId = (id) => typeof id === 'string' && /^[a-f0-9-]{36}$/.test(id);
const ownerPath = (owner) => path.join(storage, owner);
const deckPath = (owner, id) => path.join(ownerPath(owner), id);
const cleanFiles = (files = []) => Promise.all(files.map((file) => fs.rm(file.path, { force: true }).catch(() => {})));

app.disable('x-powered-by');
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  next();
});
app.use('/api', (req, res, next) => {
  const key = req.get('X-Device-Key');
  if (!validKey(key)) return res.status(401).json({ error: 'Не удалось определить устройство. Обновите страницу.' });
  req.owner = ownerHash(key);
  res.setHeader('Cache-Control', 'no-store');
  next();
});

async function readDeck(owner, id) {
  if (!validId(id)) throw Object.assign(new Error('Презентация не найдена.'), { status: 404 });
  try {
    return JSON.parse(await fs.readFile(path.join(deckPath(owner, id), 'meta.json'), 'utf8'));
  } catch {
    throw Object.assign(new Error('Презентация не найдена.'), { status: 404 });
  }
}

app.get('/api/presentations', asyncRoute(async (req, res) => {
  await fs.mkdir(ownerPath(req.owner), { recursive: true });
  const entries = await fs.readdir(ownerPath(req.owner), { withFileTypes: true });
  const decks = await Promise.all(entries.filter((entry) => entry.isDirectory() && validId(entry.name)).map(async (entry) => {
    try { return await readDeck(req.owner, entry.name); } catch { return null; }
  }));
  res.json(decks.filter(Boolean).sort((a, b) => b.createdAt - a.createdAt));
}));

async function fileType(file) {
  const handle = await fs.open(file.path, 'r');
  const buffer = Buffer.alloc(16);
  try { await handle.read(buffer, 0, 16, 0); } finally { await handle.close(); }
  if (buffer.subarray(0, 5).toString() === '%PDF-') return 'application/pdf';
  if (buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return 'image/png';
  if (buffer[0] === 255 && buffer[1] === 216 && buffer[2] === 255) return 'image/jpeg';
  if (['GIF87a', 'GIF89a'].includes(buffer.subarray(0, 6).toString())) return 'image/gif';
  if (buffer.subarray(0, 4).toString() === 'RIFF' && buffer.subarray(8, 12).toString() === 'WEBP') return 'image/webp';
  throw Object.assign(new Error('Поддерживаются PDF и изображения PNG, JPG, WebP, GIF.'), { status: 400 });
}

app.post('/api/presentations', (req, res, next) => {
  upload.array('files', 12)(req, res, async (error) => {
    if (error) {
      await cleanFiles(req.files);
      return next(error);
    }
    let directory;
    try {
      const files = req.files || [];
      if (!files.length) throw Object.assign(new Error('Выберите PDF или изображения.'), { status: 400 });
      const types = await Promise.all(files.map(fileType));
      const isPdf = types.includes('application/pdf');
      if (isPdf && files.length !== 1) throw Object.assign(new Error('Загрузите один PDF или несколько изображений.'), { status: 400 });
      const id = randomUUID();
      directory = deckPath(req.owner, id);
      await fs.mkdir(directory, { recursive: true });
      const original = Buffer.from(files[0].originalname, 'latin1').toString('utf8');
      const name = String(req.body.name || original.replace(/\.[^.]+$/, '')).trim().slice(0, 100) || 'Без названия';
      const meta = {
        id, name, type: isPdf ? 'pdf' : 'images', createdAt: Date.now(),
        size: files.reduce((total, file) => total + file.size, 0),
        files: files.map((file, index) => ({ index, type: types[index] })),
        count: isPdf ? null : files.length
      };
      await Promise.all(files.map((file, index) => fs.rename(file.path, path.join(directory, String(index)))));
      await fs.writeFile(path.join(directory, 'meta.json'), JSON.stringify(meta));
      res.status(201).json(meta);
    } catch (error) {
      await cleanFiles(req.files);
      if (directory) await fs.rm(directory, { recursive: true, force: true });
      next(error);
    }
  });
});

app.get('/api/presentations/:id/files/:index', asyncRoute(async (req, res) => {
  const deck = await readDeck(req.owner, req.params.id);
  const index = Number(req.params.index);
  if (!Number.isInteger(index) || index < 0 || index >= deck.files.length) return res.status(404).json({ error: 'Слайд не найден.' });
  res.type(deck.files[index].type);
  res.sendFile(path.join(deckPath(req.owner, deck.id), String(index)));
}));

app.delete('/api/presentations/:id', asyncRoute(async (req, res) => {
  const deck = await readDeck(req.owner, req.params.id);
  if ([...rooms.values()].some((room) => room.owner === req.owner && room.state.deckId === deck.id)) {
    return res.status(409).json({ error: 'Сначала остановите эту презентацию.' });
  }
  await fs.rm(deckPath(req.owner, deck.id), { recursive: true, force: true });
  res.json({ ok: true });
}));

app.use('/vendor/pdfjs', express.static(path.join(root, 'node_modules/pdfjs-dist/build')));
app.use(express.static(path.join(root, 'public'), { extensions: ['html'] }));
app.use((error, req, res, next) => {
  if (res.headersSent) return next(error);
  if (error instanceof multer.MulterError) {
    return res.status(400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? 'Файл слишком большой. Максимум — 40 МБ.' : 'Можно загрузить не более 12 изображений или один PDF.' });
  }
  if (!error.status) console.error(error);
  res.status(error.status || 500).json({ error: error.status ? error.message : 'Что-то пошло не так. Попробуйте ещё раз.' });
});

function publicRoom(room) {
  return {
    code: room.code, screenOnline: Boolean(room.screen), controllers: room.controllers.size,
    state: room.state
  };
}
function broadcast(room) { io.to(room.code).emit('room:update', publicRoom(room)); }
function emptyState() { return { deckId: null, title: '', slide: 0, total: 0, playing: false, blank: false }; }
function makeCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let code;
  do { code = [...randomBytes(6)].map((byte) => alphabet[byte % alphabet.length]).join(''); } while (rooms.has(code));
  return code;
}
function leave(socket) {
  const room = rooms.get(socket.data.code);
  if (!room) return;
  socket.leave(room.code);
  if (room.screen === socket.id) {
    room.screen = null;
    clearTimeout(room.expiry);
    room.expiry = setTimeout(() => {
      io.to(room.code).emit('room:closed');
      for (const member of io.sockets.adapter.rooms.get(room.code) || []) {
        const other = io.sockets.sockets.get(member);
        if (other) { other.data.code = null; other.data.role = null; other.leave(room.code); }
      }
      rooms.delete(room.code);
    }, 120000);
  }
  room.controllers.delete(socket.id);
  socket.data.code = null;
  socket.data.role = null;
  broadcast(room);
}
function screenRoom(socket) {
  const room = rooms.get(socket.data.code);
  return room && room.screen === socket.id ? room : null;
}

io.on('connection', (socket) => {
  let lastAction = 0;
  const replyError = (ack, message) => { if (typeof ack === 'function') ack({ error: message }); };
  socket.on('room:create', ({ key } = {}, ack) => {
    if (!validKey(key)) return replyError(ack, 'Обновите страницу и попробуйте снова.');
    if (Date.now() - lastAction < 700) return replyError(ack, 'Подождите секунду.');
    lastAction = Date.now();
    const owner = ownerHash(key);
    if ([...rooms.values()].some((room) => room.owner === owner)) return replyError(ack, 'На этом устройстве уже открыта комната. Вернитесь в неё или закройте её.');
    if (rooms.size >= 1000) return replyError(ack, 'Сервер занят. Попробуйте позже.');
    leave(socket);
    const room = { code: makeCode(), owner, screen: socket.id, controllers: new Set(), state: emptyState(), expiry: null };
    rooms.set(room.code, room);
    socket.data.code = room.code;
    socket.data.role = 'screen';
    socket.join(room.code);
    if (typeof ack === 'function') ack({ room: publicRoom(room), role: 'screen' });
  });
  socket.on('room:join', ({ code } = {}, ack) => {
    if (Date.now() - lastAction < 500) return replyError(ack, 'Подождите секунду.');
    lastAction = Date.now();
    const room = rooms.get(String(code || '').toUpperCase().replace(/\s/g, ''));
    if (!room) return replyError(ack, 'Комната не найдена. Проверьте код.');
    if (room.screen === socket.id) return replyError(ack, 'Это устройство уже является экраном.');
    if (!room.screen) return replyError(ack, 'Экран отключён. Дождитесь его подключения.');
    if (room.controllers.size >= 12) return replyError(ack, 'В комнате уже 12 пультов.');
    leave(socket);
    room.controllers.add(socket.id);
    socket.data.code = room.code;
    socket.data.role = 'remote';
    socket.join(room.code);
    if (typeof ack === 'function') ack({ room: publicRoom(room), role: 'remote' });
    broadcast(room);
  });
  socket.on('room:resume', ({ key, code, role } = {}, ack) => {
    const room = rooms.get(code);
    if (!room) return replyError(ack, 'Комната закрыта. Создайте новую.');
    if (role === 'screen') {
      if (!validKey(key) || room.owner !== ownerHash(key)) return replyError(ack, 'Нет доступа к экрану.');
      if (room.screen && room.screen !== socket.id) return replyError(ack, 'Экран уже открыт в другой вкладке.');
      clearTimeout(room.expiry);
      room.screen = socket.id;
    } else {
      if (room.controllers.size >= 12) return replyError(ack, 'В комнате уже 12 пультов.');
      room.controllers.add(socket.id);
      role = 'remote';
    }
    socket.data.code = room.code;
    socket.data.role = role;
    socket.join(room.code);
    if (typeof ack === 'function') ack({ room: publicRoom(room), role });
    broadcast(room);
  });
  socket.on('presentation:start', async ({ id, total } = {}, ack) => {
    const room = screenRoom(socket);
    if (!room) return replyError(ack, 'Только экран может запускать презентации.');
    try {
      const deck = await readDeck(room.owner, id);
      if (screenRoom(socket) !== room || !rooms.has(room.code)) return replyError(ack, 'Комната закрыта.');
      if (!Number.isInteger(total) || total < 1 || total > 10000 || (deck.type === 'images' && total !== deck.files.length)) return replyError(ack, 'Некорректное количество слайдов.');
      room.state = { deckId: deck.id, title: deck.name, slide: 0, total, playing: true, blank: false };
      if (typeof ack === 'function') ack({ ok: true });
      broadcast(room);
    } catch (error) { replyError(ack, error.message); }
  });
  socket.on('presentation:command', ({ action } = {}, ack) => {
    const room = rooms.get(socket.data.code);
    if (!room || (!room.controllers.has(socket.id) && room.screen !== socket.id)) return replyError(ack, 'Сначала подключитесь к комнате.');
    if (!room.screen) return replyError(ack, 'Экран временно отключён.');
    if (!room.state.playing) return replyError(ack, 'На экране ещё не запущена презентация.');
    if (Date.now() - (socket.data.lastCommand || 0) < 80) return replyError(ack, '');
    socket.data.lastCommand = Date.now();
    if (action === 'next') room.state.slide = Math.min(room.state.total - 1, room.state.slide + 1);
    else if (action === 'prev') room.state.slide = Math.max(0, room.state.slide - 1);
    else if (action === 'blank') room.state.blank = !room.state.blank;
    else if (action === 'stop' && room.screen === socket.id) room.state = emptyState();
    else return replyError(ack, 'Недоступная команда.');
    broadcast(room);
    if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('room:leave', (_, ack) => {
    const room = screenRoom(socket);
    if (room) {
      clearTimeout(room.expiry);
      io.to(room.code).emit('room:closed');
      for (const id of [...(io.sockets.adapter.rooms.get(room.code) || [])]) {
        const member = io.sockets.sockets.get(id);
        if (member) { member.leave(room.code); member.data.code = null; member.data.role = null; }
      }
      rooms.delete(room.code);
    } else leave(socket);
    if (typeof ack === 'function') ack({ ok: true });
  });
  socket.on('disconnect', () => leave(socket));
});

const port = Number(process.env.PORT) || 3000;
server.listen(port, '0.0.0.0', () => console.log(`al present → http://localhost:${port}`));
