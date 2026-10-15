// Работа с официальным Canva Connect API: вход через OAuth (PKCE), выгрузка слайдов
// картинками и поиск слайдов с видео. Слайд с видео Canva выгружает в MP4 длиной
// с само видео, обычный слайд — ровно 5 секунд. По этому признаку видео и находим.
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { promises as fs, createWriteStream } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import path from 'node:path';

const API = process.env.CANVA_API_URL || 'https://api.canva.com/rest/v1';
const AUTHORIZE = process.env.CANVA_AUTH_URL || 'https://www.canva.com/api/oauth/authorize';
const SCOPES = 'design:meta:read design:content:read';
const clientId = process.env.CANVA_CLIENT_ID;
const clientSecret = process.env.CANVA_CLIENT_SECRET;
const STATIC_PAGE_SECONDS = 5;
const MAX_PAGES = 150;

const fail = (message, status = 400) => Object.assign(new Error(message), { status });
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const challenge = (verifier) => createHash('sha256').update(verifier).digest('base64url');

export function createCanva({ tokenFile }) {
  const configured = Boolean(clientId && clientSecret);
  const states = new Map();
  const refreshing = new Map();

  const readTokens = async (owner) => {
    try { return JSON.parse(await fs.readFile(tokenFile(owner), 'utf8')); } catch { return null; }
  };
  const saveTokens = async (owner, tokens) => {
    await fs.mkdir(path.dirname(tokenFile(owner)), { recursive: true });
    const tmp = `${tokenFile(owner)}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(tokens), { mode: 0o600 });
    await fs.rename(tmp, tokenFile(owner));
  };

  async function tokenRequest(params) {
    let res;
    try {
      res = await fetch(`${API}/oauth/token`, {
        method: 'POST',
        headers: {
          Authorization: 'Basic ' + Buffer.from(`${clientId}:${clientSecret}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams(params),
        signal: AbortSignal.timeout(20000)
      });
    } catch {
      throw fail('Нет связи с Canva. Попробуйте ещё раз.', 502);
    }
    const body = await res.json().catch(() => ({}));
    if (!res.ok || !body.access_token) {
      throw Object.assign(fail('Canva не выдала доступ. Подключите Canva заново.', 401), { rejected: res.status >= 400 && res.status < 500 });
    }
    return {
      access_token: body.access_token,
      refresh_token: body.refresh_token,
      expires_at: Date.now() + (Number(body.expires_in) || 3600) * 1000
    };
  }

  function startAuth(owner, redirectUri) {
    if (!configured) throw fail('Canva не настроена на сервере.', 400);
    for (const [key, value] of states) if (Date.now() - value.at > 600000) states.delete(key);
    const state = randomBytes(24).toString('base64url');
    const verifier = randomBytes(64).toString('base64url');
    states.set(state, { owner, verifier, redirectUri, at: Date.now() });
    const query = new URLSearchParams({
      code_challenge_method: 's256', response_type: 'code', client_id: clientId,
      redirect_uri: redirectUri, scope: SCOPES, code_challenge: challenge(verifier), state
    });
    return `${AUTHORIZE}?${query}`;
  }

  async function finishAuth(state, code) {
    const pending = states.get(state);
    states.delete(state);
    if (!pending || Date.now() - pending.at > 600000) throw fail('Ссылка для входа устарела. Нажмите «Подключить Canva» ещё раз.');
    if (!code) throw fail('Canva не вернула код входа. Попробуйте ещё раз.');
    const tokens = await tokenRequest({ grant_type: 'authorization_code', code, code_verifier: pending.verifier, redirect_uri: pending.redirectUri });
    await saveTokens(pending.owner, tokens);
  }

  async function accessToken(owner, force = false) {
    if (refreshing.has(owner)) return refreshing.get(owner);
    const tokens = await readTokens(owner);
    if (!tokens) throw fail('Сначала подключите Canva.', 401);
    if (!force && tokens.expires_at - 60000 > Date.now()) return tokens.access_token;
    // refresh_token в Canva одноразовый — параллельные обновления склеиваем в одно
    if (refreshing.has(owner)) return refreshing.get(owner);
    const job = (async () => {
      try {
        const fresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token });
        await saveTokens(owner, fresh);
        return fresh.access_token;
      } catch (error) {
        if (!error.rejected) throw error;
        // Возможно, токен уже обновил параллельный запрос — тогда берём свежий
        const current = await readTokens(owner);
        if (current && current.refresh_token !== tokens.refresh_token) return current.access_token;
        await fs.rm(tokenFile(owner), { force: true });
        throw fail('Доступ к Canva истёк. Подключите Canva заново.', 401);
      } finally {
        refreshing.delete(owner);
      }
    })();
    refreshing.set(owner, job);
    return job;
  }

  function apiError(status, body) {
    if (status === 401) return fail('Доступ к Canva истёк. Подключите Canva заново.', 401);
    if (status === 403 || status === 404) return fail('Нет доступа к этой презентации. Она должна быть в том аккаунте Canva, который подключён к сайту.', 403);
    if (status === 429) return fail('Canva временно ограничила выгрузки. Попробуйте через несколько минут.', 429);
    return fail(`Canva ответила ошибкой${body?.message ? `: ${String(body.message).slice(0, 200)}` : ` (${status})`}.`, 502);
  }

  async function api(owner, route, options = {}) {
    let lastStatus = 0;
    for (let attempt = 0; ; attempt++) {
      let res;
      try {
        res = await fetch(API + route, {
          method: options.method || 'GET',
          headers: {
            Authorization: `Bearer ${await accessToken(owner, lastStatus === 401)}`,
            ...(options.body ? { 'Content-Type': 'application/json' } : {})
          },
          body: options.body ? JSON.stringify(options.body) : undefined,
          signal: AbortSignal.timeout(30000)
        });
      } catch (error) {
        if (error.status) throw error;
        if (attempt < 2) { await sleep(2000); continue; }
        throw fail('Нет связи с Canva. Попробуйте ещё раз.', 502);
      }
      if (res.status === 401 && lastStatus !== 401) { lastStatus = 401; continue; }
      lastStatus = res.status;
      if ((res.status === 429 || res.status >= 500) && attempt < 4) {
        const wait = Number(res.headers.get('retry-after')) || (res.status === 429 ? 20 : 3) * (attempt + 1);
        await sleep(Math.min(wait, 90) * 1000);
        continue;
      }
      const body = await res.json().catch(() => ({}));
      if (!res.ok) throw apiError(res.status, body);
      return body;
    }
  }

  async function exportJob(owner, designId, format) {
    let { job } = await api(owner, '/exports', { method: 'POST', body: { design_id: designId, format } });
    const deadline = Date.now() + 10 * 60000;
    while (job?.status === 'in_progress') {
      if (Date.now() > deadline) throw fail('Canva слишком долго готовит файлы. Попробуйте ещё раз.', 504);
      await sleep(2000);
      ({ job } = await api(owner, `/exports/${encodeURIComponent(job.id)}`));
    }
    if (job?.status !== 'success' || !job.urls?.length) {
      throw fail(job?.error?.message ? `Canva не смогла выгрузить презентацию: ${String(job.error.message).slice(0, 200)}` : 'Canva не смогла выгрузить презентацию.', 502);
    }
    return job.urls;
  }

  async function download(url, file) {
    let res;
    try { res = await fetch(url, { signal: AbortSignal.timeout(15 * 60000) }); } catch { res = null; }
    if (!res?.ok || !res.body) throw fail('Не удалось скачать файл из Canva.', 502);
    await pipeline(Readable.fromWeb(res.body), createWriteStream(file));
    return (await fs.stat(file)).size;
  }

  async function getDesign(owner, designId) {
    const { design } = await api(owner, `/designs/${encodeURIComponent(designId)}`);
    if (!design) throw fail('Canva не нашла эту презентацию.', 404);
    if (design.page_count > MAX_PAGES) throw fail(`В презентации больше ${MAX_PAGES} слайдов — это слишком много.`);
    return design;
  }

  // deck — объект meta.json; save() сохраняет его текущее состояние; cancelled() — удалили ли презентацию
  async function importDeck({ owner, deck, dir, save, cancelled }) {
    const stop = () => { if (cancelled()) throw Object.assign(new Error('cancelled'), { cancelled: true }); };
    try {
      deck.progress = { stage: 'slides', done: 0, total: deck.count || 0 };
      await save();
      const urls = await exportJob(owner, deck.designId, { type: 'jpg', quality: 90 });
      stop();
      deck.progress.total = urls.length;
      for (let i = 0; i < urls.length; i++) {
        deck.size += await download(urls[i], path.join(dir, String(i)));
        stop();
        deck.progress.done = i + 1;
        await save();
      }
      deck.files = urls.map((_, index) => ({ index, type: 'image/jpeg' }));
      deck.count = urls.length;

      deck.progress = { stage: 'videos', done: 0, total: deck.count, failed: 0 };
      await save();
      let next = 0, fatal = null;
      const worker = async () => {
        while (next < deck.count && !fatal && !cancelled()) {
          const page = ++next;
          const tmp = path.join(dir, `check-${page}.mp4`);
          try {
            const [url] = await exportJob(owner, deck.designId, { type: 'mp4', quality: 'horizontal_1080p', pages: [page] });
            if (cancelled()) return;
            const size = await download(url, tmp);
            const seconds = await mp4Duration(tmp);
            if (!seconds) deck.progress.failed++;
            else if (Math.abs(seconds - STATIC_PAGE_SECONDS) > 0.5) {
              const video = { id: randomUUID(), slide: page - 1, type: 'video/mp4', size, auto: true };
              await fs.rename(tmp, path.join(dir, 'v-' + video.id));
              deck.videos.push(video);
              deck.size += size;
            }
          } catch (error) {
            if (error.status === 401) fatal = error;
            else deck.progress.failed++;
          } finally {
            await fs.rm(tmp, { force: true }).catch(() => {});
            deck.progress.done++;
            if (!cancelled()) await save().catch(() => {});
          }
        }
      };
      await Promise.all([worker(), worker(), worker()]);
      if (fatal) throw fatal;
      stop();
      deck.videos.sort((a, b) => a.slide - b.slide);
      deck.unchecked = deck.progress.failed;
      delete deck.progress;
      deck.status = 'ready';
      await save();
    } catch (error) {
      if (error.cancelled || cancelled()) return;
      if (!error.status) console.error(error);
      deck.status = 'error';
      deck.error = error.status ? error.message : 'Не удалось загрузить презентацию из Canva.';
      delete deck.progress;
      await save().catch(() => {});
    }
  }

  return {
    configured,
    connected: async (owner) => configured && Boolean(await readTokens(owner)),
    disconnect: (owner) => fs.rm(tokenFile(owner), { force: true }),
    startAuth, finishAuth, getDesign, importDeck
  };
}

// Длительность MP4 в секундах из заголовка mvhd — без чтения всего файла в память
export async function mp4Duration(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    const head = Buffer.alloc(16);
    let pos = 0;
    while (pos + 8 <= size) {
      await handle.read(head, 0, 16, pos);
      let length = head.readUInt32BE(0), header = 8;
      const type = head.toString('latin1', 4, 8);
      if (length === 1) { length = Number(head.readBigUInt64BE(8)); header = 16; } else if (length === 0) length = size - pos;
      if (length < header) return null;
      if (type === 'moov') {
        const moov = Buffer.alloc(Math.min(length - header, 1 << 20));
        await handle.read(moov, 0, moov.length, pos + header);
        const at = moov.indexOf('mvhd');
        if (at < 4 || at + 36 > moov.length) return null;
        const v1 = moov[at + 4] === 1;
        const scale = moov.readUInt32BE(at + (v1 ? 24 : 16));
        const duration = v1 ? Number(moov.readBigUInt64BE(at + 28)) : moov.readUInt32BE(at + 20);
        return scale ? duration / scale : null;
      }
      pos += length;
    }
    return null;
  } finally {
    await handle.close();
  }
}
