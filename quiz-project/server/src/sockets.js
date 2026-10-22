// События Socket.IO.
//
// Ведущий → сервер: host:create, host:resume, host:start, host:next, host:reveal, host:kick, host:close
// Игрок → сервер:   player:join, player:rejoin, player:answer
// Сервер → клиенты: lobby:update, game:started, question, question:progress, results,
//                   game:ceremony, game:end, room:closed, player:kicked, access:banned, error
// Подробности и форматы данных — в PROTOCOL.md.
//
// Каждый запрос клиента получает ответ через acknowledgement: { ok: true, ... } или
// { ok: false, error, code }. Если клиент не передал callback, ошибка приходит событием «error».
import { AppError, conflict, forbidden, notFound } from './errors.js';
import { consoleOnlyError, isConsoleOnly, ownerFromSocket } from './auth.js';
import { DEMO_QUIZ } from './demoQuiz.js';
import { paymentRequired } from './payments.js';
import { ipFromSocket } from './identity/clientIp.js';
import { PlayerRegistry } from './players.js';
import { RateLimiter } from './rateLimit.js';
import { STATES } from './game.js';
import { isPlainObject, validateNickname, validatePhoto, validateQuiz, validateRoomCode } from './validate.js';
import { EVENT_TYPES } from './logs/events.js';
import { publicBan } from './security/bans.js';

const playersChannel = (code) => `players:${code}`;

const CLOSE_MESSAGES = {
  'host-left': 'Ведущий отключился. Игра завершена.',
  'host-closed': 'Ведущий закрыл комнату.',
  expired: 'Время комнаты истекло.',
  'host-banned': 'Игра остановлена администратором.',
  shutdown: 'Сервер перезапускается. Игра завершена.',
};

export function registerSocketHandlers(io, { rooms, quizService, config, identity = null, events = null, payments = null }) {
  // Как часто перепроверять сессию ведущего перед командами хода игры (start/next/reveal/kick/close).
  const HOST_RECHECK_MS = config.hostSessionRecheckMs ?? 15_000;
  const eventLimiter = new RateLimiter({ windowMs: 10_000, max: 60 }); // любые события одного сокета
  // По IP считаем только неудачные попытки входа (неверный код): все игроки одной Wi-Fi сети
  // выглядят для сервера как один IP, и успешные входы ограничивать нельзя.
  const joinFailures = new RateLimiter({ windowMs: 60_000, max: 30 });
  const createLimiter = new RateLimiter({ windowMs: 60_000, max: 10 }); // создание комнат одним ведущим

  // ---------- Рассылка событий из Game ----------

  function createNotifier(room) {
    return {
      host(event, payload) {
        if (room.hostSocketId) io.to(room.hostSocketId).emit(event, payload);
      },
      allPlayers(event, payload) {
        io.to(playersChannel(room.code)).emit(event, payload);
      },
      player(player, event, payload) {
        if (player.socketId) io.to(player.socketId).emit(event, payload);
      },
    };
  }

  function hostSnapshot(room) {
    return {
      code: room.code,
      playerSiteUrl: config.playerSiteUrl,
      players: room.players.list().map((player) => PlayerRegistry.toPublic(player, { withAvatar: true })),
      ...room.game.hostSnapshot(),
    };
  }

  function lobbyUpdate(room, change) {
    const count = room.players.size;
    if (room.hostSocketId) io.to(room.hostSocketId).emit('lobby:update', { ...change, count });
    io.to(playersChannel(room.code)).emit('lobby:update', { count });
  }

  // ---------- Закрытие комнаты и удаление игроков ----------

  function closeRoom(room, reason) {
    if (room.closed) return;
    const payload = {
      reason,
      message: CLOSE_MESSAGES[reason] ?? 'Комната закрыта.',
      finished: room.game.state === STATES.FINAL,
    };
    io.to(playersChannel(room.code)).emit('room:closed', payload);
    if (room.hostSocketId) {
      io.to(room.hostSocketId).emit('room:closed', payload);
      const hostSocket = io.sockets.sockets.get(room.hostSocketId);
      if (hostSocket) hostSocket.data = {};
    }
    for (const player of room.players.list()) {
      const socket = player.socketId && io.sockets.sockets.get(player.socketId);
      if (socket) socket.data = {};
    }
    io.in(playersChannel(room.code)).socketsLeave(playersChannel(room.code));
    rooms.delete(room);
  }

  function removePlayer(room, playerId, reason) {
    const player = room.players.remove(playerId);
    if (!player) return false;
    const socket = player.socketId && io.sockets.sockets.get(player.socketId);
    if (socket) {
      if (reason === 'kicked') socket.emit('player:kicked', { message: 'Ведущий удалил вас из игры.' });
      socket.leave(playersChannel(room.code));
      socket.data = {};
    }
    lobbyUpdate(room, { action: 'leave', playerId });
    room.game.handlePlayersChanged();
    return true;
  }

  // Периодическая уборка старых и завершённых комнат.
  const sweeper = setInterval(() => {
    const now = Date.now();
    for (const room of rooms.all()) {
      const finishedLongAgo = room.game.finishedAt && now - room.game.finishedAt > config.finishedRoomTtlMs;
      if (finishedLongAgo || now - room.createdAt > config.roomMaxAgeMs) closeRoom(room, 'expired');
    }
  }, config.roomSweepIntervalMs);
  sweeper.unref();

  // ---------- Вспомогательные функции ----------

  // IP клиента по тем же правилам, что и для HTTP (src/identity/clientIp.js).
  function clientIp(socket) {
    return socket.identity?.ip ?? ipFromSocket(socket, config);
  }

  // Ведущий — только вошедший создатель игр. Сессию перепроверяем перед командами ведущего: её могли
  // отозвать (выход, смена пароля, блокировка) уже после подключения. Создание комнаты и возврат в неё —
  // всегда по БД, остальные команды — не реже раза в HOST_RECHECK_MS (ход игры не ждёт запроса к БД).
  async function requireHostAccount(socket, { maxAgeMs = 0 } = {}) {
    if (identity && socket.identity) await identity.refresh(socket.identity, { maxAgeMs });
    const owner = ownerFromSocket(socket);
    if (!owner && isConsoleOnly(socket.identity?.account)) throw consoleOnlyError();
    if (!owner) throw new AppError('Войдите в аккаунт, чтобы продолжить.', { status: 401, code: 'UNAUTHORIZED' });
    requireNotBanned(socket);
    return owner;
  }

  // Блокировки проверяются по списку в памяти — без запроса к БД на каждое игровое событие.
  function requireNotBanned(socket) {
    identity?.checkBan(socket.identity);
  }

  // Поиск комнаты при входе игрока: неверные коды считаются попытками подбора.
  function findRoomForJoin(socket, code) {
    const ip = clientIp(socket);
    if (joinFailures.isLimited(ip)) {
      throw new AppError('Слишком много попыток с неверным кодом. Подождите минуту.', { status: 429, code: 'RATE_LIMIT' });
    }
    try {
      return findRoom(code);
    } catch (error) {
      joinFailures.hit(ip);
      throw error;
    }
  }

  function on(socket, event, handler) {
    socket.on(event, async (...args) => {
      const ack = typeof args[args.length - 1] === 'function' ? args.pop() : null;
      const payload = isPlainObject(args[0]) ? args[0] : {};
      try {
        if (!eventLimiter.take(socket.id)) {
          throw new AppError('Слишком много запросов. Подождите немного.', { status: 429, code: 'RATE_LIMIT' });
        }
        const result = await handler(payload);
        ack?.({ ok: true, ...result });
      } catch (error) {
        const known = error instanceof AppError;
        if (!known) console.error(`[socket] ${event}:`, error);
        const response = {
          ok: false,
          error: known ? error.message : 'Внутренняя ошибка сервера',
          code: known ? error.code : 'INTERNAL',
        };
        if (known && error.code === 'BANNED') response.ban = error.details;
        if (ack) ack(response);
        else socket.emit('error', { event, message: response.error, code: response.code });
      }
    });
  }

  function findRoom(rawCode) {
    const checked = validateRoomCode(rawCode);
    if (!checked.ok) throw new AppError(checked.error, { code: 'BAD_CODE' });
    const room = rooms.get(checked.value);
    if (!room || room.closed) throw notFound('Комната не найдена. Проверьте код.', 'ROOM_NOT_FOUND');
    return room;
  }

  // ---------- Подключение ----------

  io.on('connection', (socket) => {
    socket.data = {};

    const requireHostRoom = async () => {
      const room = rooms.findByHostSocket(socket.id);
      if (!room) throw forbidden('Команда доступна только ведущему этой комнаты');
      const owner = await requireHostAccount(socket, { maxAgeMs: HOST_RECHECK_MS });
      if (owner.id !== room.ownerId) throw forbidden('Команда доступна только ведущему этой комнаты');
      return room;
    };

    const requirePlayer = () => {
      const { role, roomCode, playerId } = socket.data;
      const room = role === 'player' ? rooms.get(roomCode) : null;
      const player = room?.players.get(playerId);
      if (!room || !player || player.socketId !== socket.id) throw forbidden('Вы не в игре. Войдите в комнату заново.');
      return { room, player };
    };

    // ----- Ведущий -----

    on(socket, 'host:create', async (payload) => {
      const owner = await requireHostAccount(socket);
      if (socket.data.role) throw conflict('Это соединение уже участвует в игре');
      if (!createLimiter.take(owner.id)) throw new AppError('Слишком много новых комнат. Подождите минуту.', { status: 429, code: 'RATE_LIMIT' });

      let quiz;
      if (payload.demo === true) {
        // Демо запускает сервер сам — изменить его вопросы нельзя.
        quiz = validateQuiz(structuredClone(DEMO_QUIZ)).value;
      } else if (payments && !payments.canCreate(socket.identity?.account)) {
        throw paymentRequired();
      } else if (payload.quizId !== undefined) {
        const saved = await quizService.get(owner.id, payload.quizId);
        quiz = { title: saved.title, questions: saved.questions };
      } else {
        const checked = validateQuiz(payload.quiz);
        if (!checked.ok) throw new AppError(checked.errors[0], { status: 422, code: 'INVALID_QUIZ', details: checked.errors });
        quiz = checked.value;
      }

      const room = rooms.create({ quiz, ownerId: owner.id, hostSocketId: socket.id, createNotifier });
      socket.data = { role: 'host', roomCode: room.code };
      events?.record(EVENT_TYPES.roomCreate, socket.identity, {
        roomCode: room.code,
        details: { title: quiz.title, quizId: payload.quizId ?? null, demo: payload.demo === true, questions: quiz.questions.length },
      });
      return { code: room.code, hostKey: room.hostKey, snapshot: hostSnapshot(room) };
    });

    on(socket, 'host:resume', async ({ code, hostKey }) => {
      const owner = await requireHostAccount(socket);
      const room = findRoom(code);
      if (owner.id !== room.ownerId || !room.verifyHostKey(hostKey)) {
        throw notFound('Комната не найдена или уже закрыта', 'ROOM_NOT_FOUND');
      }
      if (socket.data.role === 'player') throw conflict('Это соединение уже участвует в игре как игрок');
      if (socket.data.role === 'host' && socket.data.roomCode !== room.code) throw conflict('Это соединение уже ведёт другую игру');

      // Если ведущий открыл комнату в другой вкладке — старая вкладка теряет управление.
      const previous = room.hostSocketId && room.hostSocketId !== socket.id ? io.sockets.sockets.get(room.hostSocketId) : null;
      if (previous) {
        previous.emit('room:closed', { reason: 'replaced', message: 'Комната открыта в другой вкладке.', finished: false });
        previous.data = {};
      }
      rooms.bindHost(room, socket.id);
      socket.data = { role: 'host', roomCode: room.code };
      return { snapshot: hostSnapshot(room) };
    });

    on(socket, 'host:start', async () => {
      const room = await requireHostRoom();
      room.game.start();
      return {};
    });

    on(socket, 'host:next', async () => {
      const room = await requireHostRoom();
      room.game.next();
      return { state: room.game.state };
    });

    on(socket, 'host:reveal', async ({ count }) => {
      const room = await requireHostRoom();
      return room.game.reveal(count);
    });

    on(socket, 'host:kick', async ({ playerId }) => {
      const room = await requireHostRoom();
      if (typeof playerId !== 'string' || !removePlayer(room, playerId, 'kicked')) throw notFound('Игрок не найден');
      return {};
    });

    on(socket, 'host:close', async () => {
      const room = await requireHostRoom();
      closeRoom(room, 'host-closed');
      return {};
    });

    // ----- Игрок -----

    on(socket, 'player:join', async ({ code, nickname, photo }) => {
      if (socket.data.role) throw conflict('Вы уже в игре');
      requireNotBanned(socket);

      const room = findRoomForJoin(socket, code);
      if (!room.isJoinable) throw conflict('Игра уже началась — войти нельзя', 'GAME_STARTED');

      const nick = validateNickname(nickname);
      if (!nick.ok) throw new AppError(nick.error, { code: 'BAD_NICKNAME' });
      if (room.players.isNicknameTaken(nick.value)) throw conflict('Этот ник уже занят в комнате. Выберите другой.', 'NICKNAME_TAKEN');

      const avatar = validatePhoto(photo);
      if (!avatar.ok) throw new AppError(avatar.error, { code: 'BAD_PHOTO' });

      if (room.players.isFull) throw conflict('Комната заполнена', 'ROOM_FULL');

      const player = room.players.add({ nickname: nick.value, avatar: avatar.value, socketId: socket.id });
      socket.data = { role: 'player', roomCode: room.code, playerId: player.id };
      socket.join(playersChannel(room.code));
      lobbyUpdate(room, { action: 'join', player: PlayerRegistry.toPublic(player, { withAvatar: true }) });
      events?.record(EVENT_TYPES.roomJoin, socket.identity, { nickname: player.nickname, roomCode: room.code });

      return {
        playerId: player.id,
        token: player.token,
        nickname: player.nickname,
        snapshot: room.game.playerSnapshot(player),
      };
    });

    // Возврат в игру по секретному токену (24 случайных байта) не ограничиваем по IP:
    // после сбоя сети все игроки зала переподключаются одновременно.
    on(socket, 'player:rejoin', async ({ code, token }) => {
      if (socket.data.role) throw conflict('Вы уже в игре');
      requireNotBanned(socket);

      const room = findRoom(code);
      const player = room.players.findByToken(token);
      if (!player) throw notFound('Вы больше не в этой комнате', 'PLAYER_NOT_FOUND');

      const previous = player.socketId && player.socketId !== socket.id ? io.sockets.sockets.get(player.socketId) : null;
      if (previous) {
        previous.leave(playersChannel(room.code));
        previous.data = {};
        previous.emit('room:closed', { reason: 'replaced', message: 'Вы открыли игру на другой вкладке или устройстве.', finished: false });
      }
      room.players.attachSocket(player, socket.id);
      socket.data = { role: 'player', roomCode: room.code, playerId: player.id };
      socket.join(playersChannel(room.code));
      lobbyUpdate(room, { action: 'update', player: PlayerRegistry.toPublic(player) });
      room.game.handlePlayersChanged();

      return { playerId: player.id, nickname: player.nickname, snapshot: room.game.playerSnapshot(player) };
    });

    on(socket, 'player:answer', async ({ questionIndex, answer }) => {
      requireNotBanned(socket);
      const { room, player } = requirePlayer();
      return room.game.submitAnswer(player.id, { questionIndex, answer });
    });

    // ----- Отключение -----

    socket.on('disconnect', () => {
      const { role, roomCode, playerId } = socket.data;
      const room = roomCode ? rooms.get(roomCode) : null;
      if (!room) return;

      if (role === 'host' && room.hostSocketId === socket.id) {
        // Ждём немного: ведущий мог просто перейти на следующую страницу сайта.
        rooms.unbindHost(room);
        room.hostGraceTimer = setTimeout(() => closeRoom(room, 'host-left'), config.hostReconnectMs);
        return;
      }

      const player = role === 'player' ? room.players.get(playerId) : null;
      if (!player || player.socketId !== socket.id) return;
      room.players.detachSocket(player);
      lobbyUpdate(room, { action: 'update', player: PlayerRegistry.toPublic(player) });

      if (room.game.isLobby) {
        // В лобби отключившийся игрок исчезает из списка, если не вернётся вовремя.
        player.removalTimer = setTimeout(() => removePlayer(room, player.id, 'left'), config.playerReconnectMs);
      } else {
        // Во время игры игрок сохраняет очки и может вернуться.
        room.game.handlePlayersChanged();
      }
    });
  });

  /**
   * Применить блокировки к уже подключённым: игрок удаляется из комнаты обычной логикой (как при удалении
   * ведущим), комната заблокированного ведущего закрывается; клиент получает access:banned и отключается.
   */
  function enforceBans() {
    if (!identity) return 0;
    let affected = 0;
    for (const socket of io.sockets.sockets.values()) {
      const ban = identity.banFor(socket.identity);
      if (!ban) continue;
      affected += 1;
      socket.identity.ban = ban;
      const { role, roomCode, playerId } = socket.data;
      const room = roomCode ? rooms.get(roomCode) : null;
      if (room && role === 'player') removePlayer(room, playerId, 'banned');
      if (room && role === 'host' && room.hostSocketId === socket.id) closeRoom(room, 'host-banned');
      socket.emit('access:banned', { ...publicBan(ban), contact: config.adminContact || null });
      socket.disconnect(true);
    }
    return affected;
  }

  return {
    closeRoom,
    enforceBans,
    closeAll(reason = 'shutdown') {
      for (const room of rooms.all()) closeRoom(room, reason);
    },
    stop() {
      clearInterval(sweeper);
      eventLimiter.stop();
      joinFailures.stop();
      createLimiter.stop();
    },
  };
}
