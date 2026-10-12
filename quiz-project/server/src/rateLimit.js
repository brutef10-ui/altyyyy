// Простой ограничитель частоты «N событий за окно времени» в памяти процесса.
//
// Важно: игроки одного мероприятия обычно сидят в одной Wi-Fi сети и для сервера выглядят как один IP.
// Поэтому по IP ограничиваем только НЕУДАЧНЫЕ попытки (подбор кода комнаты): hit() вызывается
// при ошибке, isLimited() проверяется перед попыткой. Успешные входы не ограничиваются.
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.cleanup(), windowMs);
    this.timer.unref();
  }

  #entry(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    return entry;
  }

  /** Засчитать событие. */
  hit(key) {
    this.#entry(key).count += 1;
  }

  /** Лимит уже исчерпан? (не засчитывает событие) */
  isLimited(key) {
    const entry = this.hits.get(key);
    return Boolean(entry && entry.resetAt > Date.now() && entry.count >= this.max);
  }

  /** Засчитать событие и вернуть, укладывается ли оно в лимит. */
  take(key) {
    const entry = this.#entry(key);
    entry.count += 1;
    return entry.count <= this.max;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  /**
   * Express-middleware, которое считает только ответы 404 «комната не найдена» (подбор кода).
   * Пока лимит не исчерпан, запросы проходят без ограничений.
   */
  failuresMiddleware(message, keyOf = (req) => req.ip) {
    return (req, res, next) => {
      const key = keyOf(req);
      if (this.isLimited(key)) {
        res.status(429).json({ error: message, code: 'RATE_LIMIT' });
        return;
      }
      res.on('finish', () => {
        if (res.statusCode === 404) this.hit(key);
      });
      next();
    };
  }

  stop() {
    clearInterval(this.timer);
  }
}
