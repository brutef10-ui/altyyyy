// Комнаты: уникальный 6-значный код, ключ ведущего, игроки и игра.
// Всё хранится только в памяти: после закрытия комнаты результаты и фото исчезают.
import { randomBytes, randomInt, timingSafeEqual } from 'node:crypto';
import { AppError } from './errors.js';
import { Game } from './game.js';
import { PlayerRegistry } from './players.js';

export class Room {
  constructor({ code, quiz, ownerId, hostSocketId, maxPlayers, createNotifier }) {
    this.code = code;
    this.quiz = quiz;
    this.ownerId = ownerId;
    this.hostSocketId = hostSocketId;
    // Секрет комнаты: позволяет ведущему вернуться после перехода между страницами сайта.
    this.hostKey = randomBytes(32).toString('hex');
    this.createdAt = Date.now();
    this.closed = false;
    this.hostGraceTimer = null;
    this.players = new PlayerRegistry({ maxPlayers });
    this.game = new Game({ quiz, players: this.players, notify: createNotifier(this) });
  }

  get isJoinable() {
    return !this.closed && this.game.isLobby;
  }

  verifyHostKey(key) {
    if (typeof key !== 'string' || key.length !== this.hostKey.length) return false;
    return timingSafeEqual(Buffer.from(key), Buffer.from(this.hostKey));
  }

  dispose() {
    this.closed = true;
    clearTimeout(this.hostGraceTimer);
    this.game.dispose();
    this.players.clear();
  }
}

export class RoomManager {
  #rooms = new Map();
  #hostIndex = new Map(); // socketId ведущего → код комнаты

  constructor({ maxRooms, maxPlayersPerRoom }) {
    this.maxRooms = maxRooms;
    this.maxPlayersPerRoom = maxPlayersPerRoom;
  }

  get size() {
    return this.#rooms.size;
  }

  all() {
    return [...this.#rooms.values()];
  }

  #generateCode() {
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const code = String(randomInt(100_000, 1_000_000));
      if (!this.#rooms.has(code)) return code;
    }
    throw new AppError('Не удалось создать комнату, попробуйте ещё раз', { status: 503, code: 'NO_CODES' });
  }

  create({ quiz, ownerId, hostSocketId, createNotifier }) {
    if (this.#rooms.size >= this.maxRooms) {
      throw new AppError('Сервер перегружен: слишком много активных комнат. Попробуйте позже.', { status: 503, code: 'TOO_MANY_ROOMS' });
    }
    const room = new Room({
      code: this.#generateCode(),
      quiz,
      ownerId,
      hostSocketId,
      maxPlayers: this.maxPlayersPerRoom,
      createNotifier,
    });
    this.#rooms.set(room.code, room);
    this.#hostIndex.set(hostSocketId, room.code);
    return room;
  }

  get(code) {
    return this.#rooms.get(code) ?? null;
  }

  findByHostSocket(socketId) {
    const code = this.#hostIndex.get(socketId);
    const room = code ? this.#rooms.get(code) : null;
    return room && room.hostSocketId === socketId ? room : null;
  }

  bindHost(room, socketId) {
    if (room.hostSocketId) this.#hostIndex.delete(room.hostSocketId);
    clearTimeout(room.hostGraceTimer);
    room.hostGraceTimer = null;
    room.hostSocketId = socketId;
    this.#hostIndex.set(socketId, room.code);
  }

  unbindHost(room) {
    if (room.hostSocketId) this.#hostIndex.delete(room.hostSocketId);
    room.hostSocketId = null;
  }

  delete(room) {
    this.unbindHost(room);
    room.dispose();
    this.#rooms.delete(room.code);
  }
}
