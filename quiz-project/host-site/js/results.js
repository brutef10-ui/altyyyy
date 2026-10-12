// Церемония награждения на экране ведущего и итоги игры.
//
// Места объявляются по очереди (обычно 3 → 2 → 1): барабанная дробь и прожектор над пустым
// пьедесталом, затем блок поднимается, появляются аватары, имена и очки. Ровно в этот момент
// страница отправляет host:reveal — и только тогда сервер сообщает этим игрокам их место.
// После первого места — полный рейтинг и кнопки «Сохранить», «Сыграть ещё раз», «На главную».
//
// Перезагрузка посреди церемонии: уже объявленные места (final.revealed) показываются сразу,
// дальше церемония продолжается с того же шага.
import { api } from './api.js';
import { editorDraft, hostSession } from './session.js';
import { closeRoom, launchGame, openHostRoom, request } from './socket.js';
import { avatar, confirmDialog, formatScore, h, plural, toast } from './ui.js';

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const ceremonyView = document.getElementById('ceremony');
const introTitle = document.getElementById('intro-title');
const introMeta = document.getElementById('intro-meta');
const startButton = document.getElementById('start');
const stageSection = document.getElementById('stage');
const caption = document.getElementById('caption');
const podium = document.getElementById('podium');
const rankingCard = document.getElementById('ranking-card');
const ranking = document.getElementById('ranking');
const ceremonyControls = document.getElementById('ceremony-controls');
const skipButton = document.getElementById('skip');
const finalActions = document.getElementById('final-actions');
const saveButton = document.getElementById('save');
const soundButton = document.getElementById('sound');

const PODIUM_LAYOUT = [2, 1, 3]; // места на пьедестале слева направо
const MEDALS = { 1: '🥇', 2: '🥈', 3: '🥉' };
const PLACE_NAMES = { 1: 'Первое место', 2: 'Второе место', 3: 'Третье место' };
const MAX_FACES = 12; // при большой ничьей остальные игроки — в значке «+N»

// Длительность барабанной дроби и паузы после объявления каждого места, мс.
const SUSPENSE_MS = { 3: 2300, 2: 2700, 1: 3300 };
const PAUSE_MS = { 3: 2800, 2: 3200, 1: 4200 };
const START_DELAY_MS = 900;
const RESUME_DELAY_MS = 1600;

let socket = null;
let attached = false; // комната подтверждена сервером (host:resume) и соединение живо
let playersById = new Map();

const ceremony = {
  final: null,
  groups: [], // [{ rank, rows }] в порядке объявления
  places: new Map(), // rank → { node, people }
  shown: 0, // сколько групп показано на экране
  serverRevealed: 0, // сколько групп сервер уже раскрыл игрокам
  started: false,
  running: false,
  skipped: false,
  finished: false,
};

// ---------- Мелочи ----------

function restartAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

const playersWord = (count) => plural(count, ['игрок', 'игрока', 'игроков']);
const questionsWord = (count) => plural(count, ['вопрос', 'вопроса', 'вопросов']);
const pointsWord = (count) => plural(count, ['очко', 'очка', 'очков']);

// Паузы церемонии можно прервать кнопкой «Показать сразу».
const pendingWaits = new Set();
function wait(ms) {
  return new Promise((resolve) => {
    const done = () => {
      clearTimeout(timer);
      pendingWaits.delete(done);
      resolve();
    };
    const timer = setTimeout(done, ms);
    pendingWaits.add(done);
  });
}

function cancelWaits() {
  [...pendingWaits].forEach((done) => done());
}

// Пока вкладка скрыта (ведущий свернул браузер на телефоне), следующее место не объявляем.
function whenVisible() {
  if (!document.hidden || ceremony.skipped) return Promise.resolve();
  return new Promise((resolve) => {
    const check = () => {
      if (document.hidden && !ceremony.skipped) return;
      document.removeEventListener('visibilitychange', check);
      pendingWaits.delete(check);
      resolve();
    };
    document.addEventListener('visibilitychange', check);
    pendingWaits.add(check);
  });
}

// ---------- Звук: всё синтезируется через WebAudio, без файлов ----------

const SOUND_KEY = 'alstudio.host.sound';

const sound = (() => {
  let muted = false;
  try {
    muted = localStorage.getItem(SOUND_KEY) === 'off';
  } catch {
    /* хранилище недоступно */
  }
  let ctx = null;
  let master = null;
  let noise = null;
  const effects = new Set();

  function ensure() {
    if (ctx) return ctx;
    const AudioCtor = window.AudioContext || window.webkitAudioContext;
    if (!AudioCtor) return null;
    try {
      ctx = new AudioCtor();
      master = ctx.createGain();
      master.gain.value = muted ? 0 : 0.9;
      // Компрессор сглаживает пики, чтобы тарелка и фанфары не хрипели в колонках проектора.
      const compressor = ctx.createDynamicsCompressor();
      master.connect(compressor).connect(ctx.destination);
      noise = ctx.createBuffer(1, Math.floor(ctx.sampleRate * 1.6), ctx.sampleRate);
      const data = noise.getChannelData(0);
      for (let index = 0; index < data.length; index += 1) data[index] = Math.random() * 2 - 1;
    } catch {
      ctx = null;
    }
    return ctx;
  }

  // Звук можно включить только по действию пользователя (клик, клавиша).
  function unlock() {
    const context = ensure();
    if (context?.state === 'suspended') context.resume().catch(() => {});
  }

  const live = () => (ctx && ctx.state === 'running' ? ctx : null);

  function bus(context) {
    const gain = context.createGain();
    gain.connect(master);
    effects.add(gain);
    return gain;
  }

  function stop() {
    if (!ctx) return;
    for (const gain of effects) {
      try {
        gain.gain.cancelScheduledValues(ctx.currentTime);
        gain.gain.setTargetAtTime(0, ctx.currentTime, 0.03);
        setTimeout(() => gain.disconnect(), 400);
      } catch {
        /* узел уже отключён */
      }
    }
    effects.clear();
  }

  // Барабанная дробь: частые короткие «щелчки» отфильтрованного шума, всё чаще и громче.
  function drumroll(durationMs) {
    const context = live();
    if (!context) return;
    try {
      const out = bus(context);
      const start = context.currentTime + 0.03;
      const length = durationMs / 1000;
      for (let time = start, hit = 0; time < start + length; hit += 1) {
        const progress = (time - start) / length;
        const source = context.createBufferSource();
        source.buffer = noise;
        const band = context.createBiquadFilter();
        band.type = 'bandpass';
        band.frequency.value = 900 + Math.random() * 500 + progress * 700;
        band.Q.value = 0.8;
        const envelope = context.createGain();
        const peak = (0.06 + 0.34 * progress * progress) * (hit % 2 ? 0.72 : 1);
        envelope.gain.setValueAtTime(0.0001, time);
        envelope.gain.exponentialRampToValueAtTime(peak, time + 0.005);
        envelope.gain.exponentialRampToValueAtTime(0.0001, time + 0.085);
        source.connect(band).connect(envelope).connect(out);
        source.start(time, Math.random() * 1.2, 0.1);
        time += 0.064 - 0.026 * progress;
      }
      // Низкий гул литавры под дробью.
      const rumble = context.createOscillator();
      rumble.type = 'sine';
      rumble.frequency.value = 58;
      const rumbleGain = context.createGain();
      rumbleGain.gain.setValueAtTime(0.0001, start);
      rumbleGain.gain.exponentialRampToValueAtTime(0.22, start + length);
      rumbleGain.gain.exponentialRampToValueAtTime(0.0001, start + length + 0.12);
      rumble.connect(rumbleGain).connect(out);
      rumble.start(start);
      rumble.stop(start + length + 0.15);
    } catch {
      /* звук — не главное */
    }
  }

  // Удар тарелки и большого барабана в момент объявления.
  function hit() {
    const context = live();
    if (!context) return;
    try {
      const out = bus(context);
      const time = context.currentTime + 0.01;
      const source = context.createBufferSource();
      source.buffer = noise;
      const highpass = context.createBiquadFilter();
      highpass.type = 'highpass';
      highpass.frequency.value = 4800;
      const cymbal = context.createGain();
      cymbal.gain.setValueAtTime(0.0001, time);
      cymbal.gain.exponentialRampToValueAtTime(0.32, time + 0.01);
      cymbal.gain.exponentialRampToValueAtTime(0.0001, time + 1.5);
      source.connect(highpass).connect(cymbal).connect(out);
      source.start(time, 0, 1.55);

      const kick = context.createOscillator();
      kick.type = 'sine';
      kick.frequency.setValueAtTime(150, time);
      kick.frequency.exponentialRampToValueAtTime(45, time + 0.35);
      const kickGain = context.createGain();
      kickGain.gain.setValueAtTime(0.0001, time);
      kickGain.gain.exponentialRampToValueAtTime(0.8, time + 0.01);
      kickGain.gain.exponentialRampToValueAtTime(0.0001, time + 0.6);
      kick.connect(kickGain).connect(out);
      kick.start(time);
      kick.stop(time + 0.65);
    } catch {
      /* звук — не главное */
    }
  }

  const midi = (note) => 440 * 2 ** ((note - 69) / 12);

  // Медная нота: два слегка расстроенных «пилообразных» генератора через раскрывающийся фильтр.
  function brass(context, out, note, time, duration, volume) {
    const filter = context.createBiquadFilter();
    filter.type = 'lowpass';
    filter.Q.value = 1.2;
    filter.frequency.setValueAtTime(700, time);
    filter.frequency.exponentialRampToValueAtTime(3200, time + 0.07);
    filter.frequency.exponentialRampToValueAtTime(1800, time + duration);
    const envelope = context.createGain();
    envelope.gain.setValueAtTime(0.0001, time);
    envelope.gain.exponentialRampToValueAtTime(volume, time + 0.03);
    envelope.gain.setValueAtTime(volume * 0.85, time + duration * 0.7);
    envelope.gain.exponentialRampToValueAtTime(0.0001, time + duration + 0.14);
    filter.connect(envelope).connect(out);
    for (const detune of [-6, 7]) {
      const oscillator = context.createOscillator();
      oscillator.type = 'sawtooth';
      oscillator.frequency.value = midi(note);
      oscillator.detune.value = detune;
      oscillator.connect(filter);
      oscillator.start(time);
      oscillator.stop(time + duration + 0.2);
    }
  }

  function fanfare(grand) {
    const context = live();
    if (!context) return;
    try {
      const out = bus(context);
      const time = context.currentTime + 0.06;
      const notes = grand
        ? [
          [67, 0, 0.12, 0.1], [72, 0.14, 0.12, 0.1], [76, 0.28, 0.12, 0.1], [79, 0.42, 0.4, 0.11],
          [76, 0.86, 0.12, 0.1], [79, 1.0, 1.7, 0.1], [72, 1.0, 1.7, 0.07], [76, 1.0, 1.7, 0.07], [84, 1.0, 1.7, 0.06],
        ]
        : [[72, 0, 0.12, 0.09], [79, 0.15, 0.7, 0.09], [76, 0.15, 0.7, 0.06]];
      for (const [note, offset, duration, volume] of notes) brass(context, out, note, time + offset, duration, volume);
    } catch {
      /* звук — не главное */
    }
  }

  function setMuted(value) {
    muted = value;
    try {
      localStorage.setItem(SOUND_KEY, muted ? 'off' : 'on');
    } catch {
      /* без сохранения */
    }
    if (ctx && master) master.gain.setTargetAtTime(muted ? 0 : 0.9, ctx.currentTime, 0.05);
  }

  return {
    unlock,
    stop,
    drumroll,
    hit,
    fanfare,
    setMuted,
    get muted() {
      return muted;
    },
  };
})();

function renderSoundButton() {
  soundButton.textContent = sound.muted ? '🔇' : '🔊';
  soundButton.setAttribute('aria-pressed', String(!sound.muted));
  soundButton.title = sound.muted ? 'Включить звук' : 'Выключить звук';
  soundButton.setAttribute('aria-label', soundButton.title);
}

soundButton.addEventListener('click', () => {
  sound.unlock();
  sound.setMuted(!sound.muted);
  renderSoundButton();
});
renderSoundButton();

// Любое действие ведущего «разблокирует» звук (например, после перезагрузки страницы).
document.addEventListener('pointerdown', () => sound.unlock());
document.addEventListener('keydown', () => sound.unlock());

// ---------- Конфетти ----------

const confetti = (() => {
  const canvas = document.getElementById('confetti');
  const context = canvas.getContext('2d');
  const palette = ['#ff4d6d', '#2f8cff', '#f2a516', '#14b885', '#ffffff', '#ff6a3d', '#ffd166'];
  let pieces = [];
  let frame = 0;
  let ratio = 1;

  const resize = () => {
    ratio = window.devicePixelRatio || 1;
    canvas.width = window.innerWidth * ratio;
    canvas.height = window.innerHeight * ratio;
  };
  resize();
  window.addEventListener('resize', resize);

  function add(piece) {
    pieces.push({
      size: (7 + Math.random() * 8) * ratio,
      angle: Math.random() * Math.PI * 2,
      spin: (Math.random() - 0.5) * 0.3,
      wobble: Math.random() * Math.PI * 2,
      round: Math.random() < 0.25,
      color: palette[Math.floor(Math.random() * palette.length)],
      ...piece,
    });
    if (!frame) frame = requestAnimationFrame(step);
  }

  function step() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    pieces = pieces.filter((piece) => piece.y < canvas.height + 40 * ratio && piece.life-- > 0);
    for (const piece of pieces) {
      piece.vx *= 0.985;
      piece.vy = piece.vy * 0.985 + 0.3 * ratio;
      piece.wobble += 0.12;
      piece.x += piece.vx + Math.sin(piece.wobble) * 0.6 * ratio;
      piece.y += piece.vy;
      piece.angle += piece.spin;
      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.angle);
      context.fillStyle = piece.color;
      if (piece.round) {
        context.beginPath();
        context.arc(0, 0, piece.size / 3, 0, Math.PI * 2);
        context.fill();
      } else {
        context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, (piece.size / 2) * Math.abs(Math.cos(piece.wobble)) + ratio);
      }
      context.restore();
    }
    frame = pieces.length ? requestAnimationFrame(step) : 0;
    if (!frame) context.clearRect(0, 0, canvas.width, canvas.height);
  }

  /** Залп из точки (x, y в CSS-пикселях) под углом angle (градусы, -90 — вверх). */
  function burst({ x, y, count = 80, angle = -90, spread = 60, speed = 15, colors = null }) {
    if (reducedMotion.matches) return;
    for (let index = 0; index < count; index += 1) {
      const direction = ((angle + (Math.random() - 0.5) * spread) * Math.PI) / 180;
      const velocity = speed * (0.55 + Math.random() * 0.6) * ratio;
      add({
        x: x * ratio,
        y: y * ratio,
        vx: Math.cos(direction) * velocity,
        vy: Math.sin(direction) * velocity,
        life: 260 + Math.random() * 120,
        ...(colors ? { color: colors[Math.floor(Math.random() * colors.length)] } : {}),
      });
    }
  }

  /** «Дождь» сверху в течение нескольких секунд. */
  function rain(durationMs = 2600, perFrame = 3) {
    if (reducedMotion.matches) return;
    const until = performance.now() + durationMs;
    const drop = () => {
      for (let index = 0; index < perFrame; index += 1) {
        add({ x: Math.random() * canvas.width, y: -20 * ratio, vx: (Math.random() - 0.5) * 2 * ratio, vy: (2 + Math.random() * 3) * ratio, life: 600 });
      }
      if (performance.now() < until) requestAnimationFrame(drop);
    };
    requestAnimationFrame(drop);
  }

  return { burst, rain };
})();

function celebrate() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  confetti.burst({ x: width * 0.08, y: height, angle: -62, spread: 34, speed: 26, count: 110 });
  confetti.burst({ x: width * 0.92, y: height, angle: -118, spread: 34, speed: 26, count: 110 });
  setTimeout(() => confetti.rain(2800, 3), 350);
}

function sparkle(node, rank) {
  const rect = node.querySelector('.podium-people')?.getBoundingClientRect();
  if (!rect) return;
  const colors = rank === 2 ? ['#ffffff', '#e5e7f0', '#a9adc4', '#2f8cff'] : ['#f0a77a', '#c56b3c', '#ffd166', '#ffffff'];
  confetti.burst({ x: rect.left + rect.width / 2, y: rect.top + rect.height / 2, angle: -90, spread: 300, speed: 11, count: 46, colors });
}

// ---------- Пьедестал ----------

function buildGroups(final) {
  const order = Array.isArray(final.revealOrder) ? final.revealOrder : [];
  const leaderboard = Array.isArray(final.leaderboard) ? final.leaderboard : [];
  return order
    .map((rank) => ({ rank, rows: leaderboard.filter((row) => row.rank === rank) }))
    .filter((group) => group.rows.length > 0);
}

function renderPodium() {
  ceremony.places.clear();
  const ranks = PODIUM_LAYOUT.filter((rank) => ceremony.groups.some((group) => group.rank === rank));
  podium.className = `podium podium-${ranks.length}`;
  podium.replaceChildren(...ranks.map((rank) => {
    const group = ceremony.groups.find((item) => item.rank === rank);
    const people = h('div', { class: 'podium-people' },
      h('div', { class: 'podium-ghost', 'aria-hidden': 'true' }, h('span', { text: '?' })),
    );
    const crowd = group.rows.length > 3 ? ' is-crowd' : group.rows.length > 1 ? ' is-pair' : '';
    const node = h('div', { class: `podium-place place-${rank}${crowd}`, dataset: { rank: String(rank), state: 'waiting' } },
      h('div', { class: 'podium-light', 'aria-hidden': 'true' }),
      people,
      h('div', { class: 'podium-column' },
        h('div', { class: 'podium-frame', 'aria-hidden': 'true' }, h('span', { text: rank })),
        h('div', { class: 'podium-block' },
          h('span', { class: 'podium-medal', 'aria-hidden': 'true', text: MEDALS[rank] || '' }),
          h('span', { class: 'podium-rank', text: rank }),
        ),
      ),
    );
    ceremony.places.set(rank, { node, people });
    return node;
  }));
}

function scoreText(value, target) {
  return `${formatScore(value)} ${pointsWord(target)}`;
}

function countUp(node, target, duration) {
  if (!duration || reducedMotion.matches || document.hidden) {
    node.textContent = scoreText(target, target);
    return;
  }
  const startedAt = performance.now();
  const step = (now) => {
    const progress = Math.min(1, (now - startedAt) / duration);
    const eased = 1 - (1 - progress) ** 3;
    node.textContent = scoreText(Math.round(target * eased), target);
    if (progress < 1) requestAnimationFrame(step);
  };
  node.textContent = scoreText(0, target);
  requestAnimationFrame(step);
}

function sizeClass(count) {
  if (count === 1) return 'size-1';
  if (count <= 3) return 'size-few';
  if (count <= 8) return 'size-many';
  return 'size-crowd';
}

/** Показывает игроков группы на их месте пьедестала. instant — без анимаций (перезагрузка). */
function revealGroup(group, { instant = false } = {}) {
  const place = ceremony.places.get(group.rank);
  if (!place) return;
  const { node, people } = place;
  const count = group.rows.length;
  const faces = group.rows.slice(0, count > MAX_FACES ? MAX_FACES - 1 : MAX_FACES);
  const rest = group.rows.slice(faces.length);

  const list = h('div', { class: `podium-group ${sizeClass(count)}` },
    ...faces.map((row, index) =>
      // Аватары появляются, когда блок пьедестала уже поднялся.
      h('div', { class: 'podium-person', title: row.nickname, style: { animationDelay: `${380 + index * 110}ms` } },
        avatar(playersById.get(row.id)?.avatar, row.nickname, 'avatar podium-avatar'),
        h('span', { class: 'podium-name', text: row.nickname }),
      ),
    ),
    rest.length
      ? h('div', { class: 'podium-person podium-more', title: rest.map((row) => row.nickname).join(', ') },
        h('span', { class: 'avatar podium-avatar avatar-placeholder', text: `+${rest.length}` }),
        h('span', { class: 'podium-name', text: `ещё ${rest.length}` }),
      )
      : null,
  );
  const score = h('span', { class: 'podium-score' });
  people.replaceChildren(list, score);
  node.classList.toggle('no-anim', instant);
  node.classList.toggle('is-winner', group.rank === 1);
  node.dataset.state = 'revealed';
  node.setAttribute('aria-label', `${PLACE_NAMES[group.rank] || `${group.rank} место`}: ${group.rows.map((row) => row.nickname).join(', ')}`);
  countUp(score, group.rows[0]?.score ?? 0, instant ? 0 : 1500);
}

function setCaption(text, mood) {
  caption.textContent = text;
  caption.className = `ceremony-caption is-${mood}`;
  if (!reducedMotion.matches) restartAnimation(caption, 'enter');
}

function suspenseCaption(group) {
  if (group.rank === 1) return group.rows.length > 1 ? '🥁 И победители…' : '🥁 И победитель…';
  return `🥁 ${PLACE_NAMES[group.rank] || `${group.rank} место`}…`;
}

function revealedCaption(group) {
  if (group.rank === 1) return group.rows.length > 1 ? '🏆 Победители!' : '🏆 Победитель!';
  const tie = group.rows.length > 1 ? ` · ${group.rows.length} ${playersWord(group.rows.length)}` : '';
  return `${MEDALS[group.rank] || ''} ${PLACE_NAMES[group.rank] || `${group.rank} место`}${tie}`.trim();
}

// ---------- Синхронизация с сервером ----------

function noteRevealed(response) {
  if (Number.isInteger(response?.revealed)) ceremony.serverRevealed = Math.max(ceremony.serverRevealed, response.revealed);
}

let syncTimer = 0;
function scheduleSync(ms) {
  clearTimeout(syncTimer);
  syncTimer = setTimeout(syncReveal, ms);
}

/** Сообщить серверу о только что показанном месте: игроки этой группы узнают его прямо сейчас. */
function pushReveal() {
  if (!attached || !socket?.connected) return; // догоним после переподключения (onReady → syncReveal)
  const target = ceremony.shown;
  // Обычный шаг — «следующая группа». Если сервер отстал (потерялся ответ), доводим до нужного числа.
  const payload = ceremony.serverRevealed === target - 1 ? {} : { count: target };
  request(socket, 'host:reveal', payload)
    .then(noteRevealed)
    .catch(() => scheduleSync(1500));
}

/** Довести число раскрытых групп на сервере до показанного на экране. */
function syncReveal() {
  if (!attached || !socket?.connected || ceremony.serverRevealed >= ceremony.shown) return;
  request(socket, 'host:reveal', { count: ceremony.shown })
    .then(noteRevealed)
    .catch(() => scheduleSync(3000));
}

// ---------- Ход церемонии ----------

function changeStage(stage) {
  const before = stageSection.getBoundingClientRect();
  ceremonyView.dataset.stage = stage;
  if (reducedMotion.matches) return;
  const after = stageSection.getBoundingClientRect();
  if (!before.width || !after.width) return;
  const dx = before.left - after.left;
  const dy = before.top - after.top;
  if (Math.abs(dx) < 1 && Math.abs(dy) < 1) return;
  stageSection.animate(
    [{ transform: `translate(${dx}px, ${dy}px)` }, { transform: 'none' }],
    { duration: 800, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
  );
}

async function suspense(group) {
  const place = ceremony.places.get(group.rank);
  if (place) place.node.dataset.state = 'suspense';
  setCaption(suspenseCaption(group), 'suspense');
  const duration = reducedMotion.matches ? Math.round(SUSPENSE_MS[group.rank] * 0.6) : SUSPENSE_MS[group.rank] ?? 2500;
  sound.drumroll(duration);
  await wait(duration);
}

function revealStep(group) {
  revealGroup(group);
  ceremony.shown += 1;
  pushReveal(); // ровно в момент показа места
  setCaption(revealedCaption(group), group.rank === 1 ? 'winner' : 'revealed');
  sound.hit();
  sound.fanfare(group.rank === 1);
  const place = ceremony.places.get(group.rank);
  if (group.rank === 1) celebrate();
  else if (place) setTimeout(() => sparkle(place.node, group.rank), 350);
}

async function runCeremony({ delay = 0 } = {}) {
  if (ceremony.running || ceremony.finished) return;
  ceremony.running = true;
  if (delay) await wait(delay);
  while (!ceremony.skipped && ceremony.shown < ceremony.groups.length) {
    await whenVisible();
    if (ceremony.skipped) break;
    const index = ceremony.shown;
    const group = ceremony.groups[index];
    await suspense(group);
    if (ceremony.skipped) break;
    if (ceremony.shown !== index) continue; // место уже показано (например, другой вкладкой)
    revealStep(group);
    await wait(PAUSE_MS[group.rank] ?? 3000);
  }
  ceremony.running = false;
  if (!ceremony.skipped) finish();
}

function startCeremony() {
  if (ceremony.started || ceremony.finished) return;
  ceremony.started = true;
  sound.unlock();
  changeStage('show');
  setCaption('Объявляем призёров', 'calm');
  runCeremony({ delay: START_DELAY_MS });
}

function skipAll() {
  if (ceremony.finished) return;
  sound.unlock();
  ceremony.skipped = true;
  ceremony.started = true;
  cancelWaits();
  sound.stop();
  for (let index = ceremony.shown; index < ceremony.groups.length; index += 1) revealGroup(ceremony.groups[index]);
  ceremony.shown = ceremony.groups.length;
  if (attached && socket?.connected) {
    request(socket, 'host:reveal', { count: ceremony.groups.length })
      .then(noteRevealed)
      .catch(() => scheduleSync(1500));
  }
  finish({ withConfetti: ceremony.groups.length > 0 });
}

function finish({ withConfetti = false } = {}) {
  if (ceremony.finished) return;
  ceremony.finished = true;
  ceremony.started = true;
  const winners = ceremony.groups.find((group) => group.rank === 1)?.rows.length ?? 0;
  if (ceremony.groups.length === 0) setCaption('Итоги игры', 'calm');
  else setCaption(winners > 1 ? 'Поздравляем победителей!' : 'Поздравляем победителя!', 'final');
  changeStage('done');
  ceremonyControls.hidden = true;
  finalActions.hidden = false;
  updateSaveButton();
  if (withConfetti) celebrate();
  syncReveal();
}

startButton.addEventListener('click', startCeremony);
skipButton.addEventListener('click', skipAll);
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select, dialog')) return;
  // Пробел и Enter на кнопке нажмут её сами.
  if (event.target.closest('button, a') && (event.key === ' ' || event.key === 'Enter')) return;
  // Пульт презентаций шлёт PageDown / стрелку вправо — им тоже можно начать церемонию.
  if (ceremonyView.dataset.stage === 'intro' && !ceremonyView.hidden && [' ', 'Enter', 'ArrowRight', 'PageDown'].includes(event.key)) {
    event.preventDefault();
    startCeremony();
  }
});

// ---------- Рейтинг ----------

function renderRanking() {
  const { leaderboard = [], totalQuestions } = ceremony.final;
  ranking.replaceChildren(...leaderboard.map((row, index) =>
    h('li', { class: `ranking-row${row.rank <= 3 ? ` rank-${row.rank}` : ''}`, style: { animationDelay: `${Math.min(index, 14) * 60}ms` } },
      h('span', { class: 'ranking-rank', text: row.rank }),
      avatar(playersById.get(row.id)?.avatar, row.nickname, 'avatar avatar-sm'),
      h('span', { class: 'ranking-name', text: row.nickname }),
      h('span', { class: 'ranking-correct muted', text: `${row.correctCount} из ${totalQuestions} верно` }),
      h('span', { class: 'ranking-score', text: formatScore(row.score) }),
    ),
  ));
  rankingCard.hidden = leaderboard.length === 0;
  ceremonyView.classList.toggle('has-ranking', leaderboard.length > 0);
}

// ---------- Первый показ и переподключение ----------

function init(final) {
  ceremony.final = final;
  ceremony.groups = buildGroups(final);
  ceremony.serverRevealed = final.revealed ?? 0;

  const playerCount = final.playerCount ?? final.leaderboard?.length ?? 0;
  document.getElementById('quiz-title').textContent = final.title;
  document.getElementById('player-total').textContent = `${playerCount} ${playersWord(playerCount)}`;
  document.title = `AL Studio — награждение: ${final.title}`;
  introTitle.textContent = final.title;
  introMeta.textContent = `${playerCount} ${playersWord(playerCount)} · ${final.totalQuestions} ${questionsWord(final.totalQuestions)}`;

  renderPodium();
  renderRanking();
  ceremonyView.hidden = false;

  if (ceremony.groups.length === 0) {
    podium.replaceChildren(h('div', { class: 'podium-empty' },
      h('span', { class: 'podium-empty-icon', 'aria-hidden': 'true', text: '🎈' }),
      h('p', { text: 'В игре не осталось игроков — награждать некого.' }),
    ));
    finish();
    return;
  }

  const revealed = Math.min(Math.max(0, final.revealed ?? 0), ceremony.groups.length);
  if (revealed === 0) {
    changeStage('intro');
    return;
  }

  // Перезагрузка посреди церемонии: уже объявленные места — сразу, дальше — по порядку.
  ceremony.groups.slice(0, revealed).forEach((group) => revealGroup(group, { instant: true }));
  ceremony.shown = revealed;
  ceremony.started = true;
  if (revealed >= ceremony.groups.length) {
    finish();
    return;
  }
  changeStage('show');
  setCaption(revealedCaption(ceremony.groups[revealed - 1]), 'revealed');
  runCeremony({ delay: RESUME_DELAY_MS });
}

function resync(final) {
  // Соединение восстановилось: сверяемся с сервером.
  ceremony.serverRevealed = final.revealed ?? 0;
  if (ceremony.serverRevealed > ceremony.shown) {
    // Сервер ушёл вперёд (например, места показали из другой вкладки) — догоняем без анимаций.
    ceremony.groups.slice(ceremony.shown, ceremony.serverRevealed).forEach((group) => revealGroup(group, { instant: true }));
    ceremony.shown = Math.min(ceremony.serverRevealed, ceremony.groups.length);
    if (!ceremony.started && ceremony.shown > 0) {
      ceremony.started = true;
      changeStage('show');
      runCeremony({ delay: RESUME_DELAY_MS });
    }
    if (ceremony.shown >= ceremony.groups.length && !ceremony.running) finish();
  } else {
    syncReveal();
  }
}

// ---------- Сохранение ----------

function updateSaveButton() {
  const session = hostSession.get();
  saveButton.hidden = false;
  if (session?.draft) {
    saveButton.disabled = false;
    saveButton.textContent = session.quizId ? '💾 Сохранить изменения' : '💾 Сохранить игру';
  } else {
    saveButton.disabled = true;
    saveButton.textContent = '✓ Игра сохранена';
  }
}

saveButton.addEventListener('click', async () => {
  const session = hostSession.get();
  if (!session?.draft) return;
  saveButton.disabled = true;
  try {
    const saved = session.quizId
      ? await api.updateQuiz(session.quizId, session.draft)
      : await api.createQuiz(session.draft);
    if (!session.quizId) editorDraft.clear();
    hostSession.patch({ quizId: saved.id, draft: null });
    toast('Игра сохранена — она появится в списке на главной', 'success');
  } catch (error) {
    toast(error.details?.[0] || error.message, 'error', 6000);
  }
  updateSaveButton();
});

// ---------- Навигация ----------

document.getElementById('home').addEventListener('click', async () => {
  const session = hostSession.get();
  if (session?.draft) {
    const confirmed = await confirmDialog({
      title: 'Выйти без сохранения?',
      message: 'Эта игра ещё не сохранена. Чтобы запустить её снова позже, нажмите «Сохранить игру».',
      confirmText: 'Выйти',
      cancelText: 'Остаться',
      danger: true,
    });
    if (!confirmed) return;
  }
  await closeRoom(socket);
  location.href = 'index.html';
});

document.getElementById('replay').addEventListener('click', async () => {
  const session = hostSession.get();
  await closeRoom(socket);
  launchGame(session?.draft ? { quizId: session.quizId, quiz: session.draft } : { quizId: session?.quizId });
});

// ---------- Подключение ----------

socket = await openHostRoom({
  page: 'results.html',
  onReady(snapshot) {
    attached = true;
    playersById = new Map(snapshot.players.map((player) => [player.id, player]));
    if (!ceremony.final) init(snapshot.final);
    else resync(snapshot.final);
  },
});

socket.on('disconnect', () => {
  attached = false;
});
