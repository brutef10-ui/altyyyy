// Игроки комнаты: ник, аватар, очки, привязка к сокету.
// Фото хранится только в памяти и исчезает вместе с комнатой.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { nicknameKey } from './validate.js';

function sameSecret(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export class PlayerRegistry {
  #players = new Map();

  constructor({ maxPlayers }) {
    this.maxPlayers = maxPlayers;
  }

  get size() {
    return this.#players.size;
  }

  get isFull() {
    return this.#players.size >= this.maxPlayers;
  }

  list() {
    return [...this.#players.values()];
  }

  connected() {
    return this.list().filter((player) => player.connected);
  }

  get(id) {
    return this.#players.get(id) ?? null;
  }

  findByToken(token) {
    if (typeof token !== 'string') return null;
    for (const player of this.#players.values()) {
      if (sameSecret(player.token, token)) return player;
    }
    return null;
  }

  isNicknameTaken(nickname) {
    const key = nicknameKey(nickname);
    for (const player of this.#players.values()) {
      if (player.nicknameKey === key) return true;
    }
    return false;
  }

  add({ nickname, avatar, socketId }) {
    let id;
    do id = randomBytes(6).toString('hex'); while (this.#players.has(id));

    const player = {
      id,
      token: randomBytes(24).toString('hex'),
      nickname,
      nicknameKey: nicknameKey(nickname),
      avatar,
      socketId,
      connected: true,
      joinedAt: Date.now(),
      score: 0,
      lastPoints: 0,
      correctCount: 0,
      removalTimer: null,
    };
    this.#players.set(id, player);
    return player;
  }

  remove(id) {
    const player = this.#players.get(id);
    if (!player) return null;
    clearTimeout(player.removalTimer);
    this.#players.delete(id);
    return player;
  }

  attachSocket(player, socketId) {
    clearTimeout(player.removalTimer);
    player.removalTimer = null;
    player.socketId = socketId;
    player.connected = true;
  }

  detachSocket(player) {
    player.socketId = null;
    player.connected = false;
  }

  clear() {
    for (const player of this.#players.values()) clearTimeout(player.removalTimer);
    this.#players.clear();
  }

  static toPublic(player, { withAvatar = false } = {}) {
    const data = {
      id: player.id,
      nickname: player.nickname,
      score: player.score,
      connected: player.connected,
    };
    if (withAvatar) data.avatar = player.avatar;
    return data;
  }
}
