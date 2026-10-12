// Простой ограничитель частоты запросов «N событий за окно времени» в памяти процесса.
export class RateLimiter {
  constructor({ windowMs, max }) {
    this.windowMs = windowMs;
    this.max = max;
    this.hits = new Map();
    this.timer = setInterval(() => this.cleanup(), windowMs);
    this.timer.unref();
  }

  take(key) {
    const now = Date.now();
    let entry = this.hits.get(key);
    if (!entry || entry.resetAt <= now) {
      entry = { count: 0, resetAt: now + this.windowMs };
      this.hits.set(key, entry);
    }
    entry.count += 1;
    return entry.count <= this.max;
  }

  cleanup() {
    const now = Date.now();
    for (const [key, entry] of this.hits) {
      if (entry.resetAt <= now) this.hits.delete(key);
    }
  }

  middleware(message, keyOf = (req) => req.ip) {
    return (req, res, next) => {
      if (this.take(keyOf(req))) return next();
      res.status(429).json({ error: message, code: 'RATE_LIMIT' });
    };
  }

  stop() {
    clearInterval(this.timer);
  }
}
