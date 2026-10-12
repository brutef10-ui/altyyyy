// Экран игрока: ожидание старта → вопрос (сначала только текст и картинка, затем варианты или поле
// для ответа) → результат после каждого вопроса → ожидание церемонии → своё место → пьедестал.
// Очки, время и места считает сервер; здесь только отображение. Протокол — PROTOCOL.md.
import { SERVER_URL } from './config.js';
import { goTo, playerState } from './session.js';
import { connectPlayer, request } from './socket.js';
import { ANSWER_SHAPES, formatScore, h, pencilIcon, plural, shapeIcon, vibrate } from './ui.js';

const state = playerState.get();
const $ = (id) => document.getElementById(id);

const views = [...document.querySelectorAll('.view')];
const reconnectBanner = $('reconnect');
const reconnectText = $('reconnect-text');
const scoreValue = $('me-score');
const scorePill = $('me-score-pill');

const questionView = $('view-question');
const kindTag = $('q-kind');
const secondsValue = $('q-seconds');
const timebar = $('timebar');
const media = $('q-media');
const mediaImage = $('q-image');
const readingBox = $('q-reading');
const readRing = $('read-ring');
const readSeconds = $('read-seconds');
const readCaption = $('read-caption');
const readScreenReader = $('read-sr');
const answerButtons = $('answer-buttons');
const textForm = $('text-answer');
const textInput = $('text-input');
const textSubmit = $('text-submit');
const textHint = $('text-hint');
const textCounter = $('text-counter');

const TEXT_HINT = 'Регистр и мелкие опечатки не важны';
const MAX_RETRY_DELAY_MS = 10_000;
// Ошибки входа, после которых надо просто попробовать ещё раз (сервер занят, ответ потерялся).
const TRANSIENT_CODES = new Set(['TIMEOUT', 'RATE_LIMIT', 'INTERNAL', 'UNKNOWN', 'DISCONNECTED', 'CONFLICT']);

let socket = null;
let finished = false; // комната закрыта, игрок удалён или фатальная ошибка — больше не переподключаемся
let connectSeq = 0; // номер попытки входа: ответы старых попыток игнорируются
let entered = false; // на текущем соединении игрок вернулся в комнату
let entering = false;
let queuedEvents = []; // события, пришедшие во время входа, — применяются после снимка состояния
let retryAttempt = 0;
let retryTimer = 0;
let hiddenAt = 0;

let currentView = 'view-connecting';
let question = null; // последний payload события question
let myAnswer = null; // { index, value } — ответ на текущий вопрос
let sending = false; // ответ отправляется
let timerFrame = 0;
let wakeLock = null;
let mediaRetryTimer = 0;
let shownFinal = null; // { rank, complete } — что уже показано на экране финала

// ---------- Проверка шагов входа ----------

function guard() {
  let redirect = null;
  if (!state.code) redirect = ['index.html', 'Введите код комнаты'];
  else if (state.token) return true; // можно вернуться в игру после перезагрузки страницы
  else if (!state.photo) redirect = ['photo.html', 'Сначала добавьте фото'];
  else if (!state.nickname) redirect = ['name.html'];
  if (!redirect) return true;
  goTo(...redirect);
  return false;
}

// ---------- Экраны ----------

function show(id, mood = '') {
  const changed = currentView !== id;
  for (const view of views) view.hidden = view.id !== id;
  if (changed) {
    const current = $(id);
    current.classList.remove('enter');
    void current.offsetWidth;
    current.classList.add('enter');
    current.scrollTop = 0;
    if (document.activeElement === textInput) textInput.blur(); // спрятать клавиатуру
  }
  currentView = id;
  document.body.dataset.mood = mood;
  if (id !== 'view-question') stopTimer();
}

function setScore(score) {
  const hidden = score === null || score === undefined;
  scoreValue.textContent = hidden ? '?' : formatScore(score);
  scorePill.classList.toggle('is-hidden', hidden);
  scorePill.setAttribute('aria-label', hidden ? 'Очки скрыты до церемонии награждения' : 'Ваши очки');
}

function renderHeader() {
  const current = playerState.get();
  const avatar = $('me-avatar');
  if (current.photo) {
    avatar.src = current.photo;
    avatar.hidden = false;
    $('wait-avatar').src = current.photo;
  } else {
    avatar.hidden = true;
  }
  $('me-name').textContent = current.nickname || '';
}

function showWaiting(count) {
  $('wait-count').textContent = `Игроков в комнате: ${count}`;
  show('view-waiting');
}

function showMessage({ title, text, icon = '!', actions = [] }) {
  $('message-icon').textContent = icon;
  $('message-title').textContent = title;
  $('message-text').textContent = text;
  $('message-actions').replaceChildren(...actions);
  show('view-message', 'neutral');
}

const homeButton = (label = 'На главную') =>
  h('a', { class: 'btn btn-primary btn-block', href: 'index.html', text: label });
const retryButton = () =>
  h('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'Попробовать снова', onclick: () => location.reload() });

function flashToast(message, tone = 'error') {
  document.querySelector('.toast')?.remove();
  const toast = h('div', { class: `toast toast-${tone}`, role: 'status', text: message });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3500);
}

function showBanner(text = 'Связь потеряна. Переподключаемся…') {
  // На экране подключения плашка не нужна: тот же текст показываем под индикатором.
  if (currentView === 'view-connecting') {
    $('connecting-text').textContent = text.startsWith('Сервер занят') ? text : 'Не удаётся связаться с сервером. Пробуем снова…';
    return;
  }
  reconnectText.textContent = text;
  reconnectBanner.hidden = false;
}

function hideBanner() {
  reconnectBanner.hidden = true;
}

// ---------- Вопрос ----------

function kindTagContent(type) {
  if (type === 'text') return [pencilIcon('kind-icon'), h('span', { text: 'Свой ответ' })];
  return [
    h('span', { class: 'kind-shapes' }, ANSWER_SHAPES.map((_, index) => h('span', { class: `answer-${index}` }, shapeIcon(index, 'shape')))),
    h('span', { text: 'Варианты' }),
  ];
}

/** Картинка вопроса: место под неё зарезервировано, сама картинка плавно проявляется после загрузки. */
function setMedia(imageId) {
  if (!imageId) {
    clearTimeout(mediaRetryTimer);
    media.hidden = true;
    media.dataset.id = '';
    mediaImage.removeAttribute('src');
    return;
  }
  media.hidden = false;
  // Та же картинка (смена фазы или следующий вопрос) — не перезагружаем, если она уже на экране.
  if (media.dataset.id === imageId && !media.classList.contains('is-broken')) return;
  media.dataset.id = imageId;
  media.classList.remove('is-loaded', 'is-broken');
  loadMediaImage(imageId, 0);
}

// Картинка не загрузилась (сеть моргнула) — ещё две попытки, потом заглушка.
function loadMediaImage(imageId, attempt) {
  clearTimeout(mediaRetryTimer);
  const current = () => media.dataset.id === imageId;
  mediaImage.onload = () => {
    if (current()) media.classList.add('is-loaded');
  };
  mediaImage.onerror = () => {
    if (!current()) return;
    if (attempt < 2) mediaRetryTimer = setTimeout(() => current() && loadMediaImage(imageId, attempt + 1), 1500 * (attempt + 1));
    else media.classList.add('is-broken');
  };
  mediaImage.src = `${SERVER_URL}/api/images/${encodeURIComponent(imageId)}${attempt ? `?retry=${attempt}` : ''}`;
  if (mediaImage.complete && mediaImage.naturalWidth) media.classList.add('is-loaded');
}

function renderQuestion(data, answer = null) {
  const isNew = !question || question.index !== data.index;
  question = data;
  if (isNew) {
    myAnswer = null;
    sending = false;
    $('q-number').textContent = `Вопрос ${data.index + 1} из ${data.totalQuestions}`;
    $('q-text').textContent = data.text;
    questionView.dataset.long = String([...data.text].length > 110);
    kindTag.replaceChildren(...kindTagContent(data.type));
    kindTag.setAttribute('aria-label', data.type === 'text' ? 'Ответ нужно написать' : 'Ответ нужно выбрать');
    answerButtons.replaceChildren();
    textInput.value = '';
  }
  setMedia(data.image);
  questionView.dataset.type = data.type;

  if (answer !== null && answer !== undefined) myAnswer = { index: data.index, value: answer };
  if (myAnswer?.index === data.index) {
    showAnswered(myAnswer.value);
    return;
  }

  if (data.phase === 'reading') renderReading(data);
  else renderAnswering(data);
  show('view-question');
}

function renderReading(data) {
  questionView.dataset.phase = 'reading';
  readingBox.hidden = false;
  answerButtons.hidden = true;
  textForm.hidden = true;
  readCaption.textContent = data.type === 'text' ? 'Поле для ответа появится через' : 'Варианты появятся через';
  const totalMs = Math.max(1, (data.readTime || 0) * 1000);
  const remainingMs = Math.min(totalMs, data.readRemainingMs ?? totalMs);
  runCountdown(remainingMs, (left) => {
    const seconds = String(Math.ceil(left / 1000));
    if (readSeconds.textContent !== seconds) {
      readSeconds.textContent = seconds;
      readScreenReader.textContent = ` ${seconds} с`;
    }
    readRing.style.strokeDashoffset = String(100 - (left / totalMs) * 100);
  });
}

function renderAnswering(data) {
  const wasReading = questionView.dataset.phase === 'reading' && currentView === 'view-question';
  questionView.dataset.phase = 'answering';
  readingBox.hidden = true;

  if (data.type === 'text') {
    answerButtons.hidden = true;
    textForm.hidden = false;
    const maxLength = Number.isInteger(data.maxLength) && data.maxLength > 0 ? data.maxLength : 80;
    textInput.maxLength = maxLength;
    setTextLocked(false);
    updateTextCounter();
    setTextHint(TEXT_HINT);
    // На телефоне клавиатура может не открыться без касания — но курсор уже в поле.
    requestAnimationFrame(() => textInput.focus({ preventScroll: true }));
  } else {
    textForm.hidden = true;
    renderAnswerButtons(data.answers || []);
    answerButtons.hidden = false;
  }
  if (wasReading) vibrate(25);

  const totalMs = data.timeLimit * 1000;
  runCountdown(Math.min(totalMs, data.remainingMs ?? totalMs), (left) => {
    secondsValue.textContent = Math.ceil(left / 1000);
    timebar.style.transform = `scaleX(${left / totalMs})`;
    timebar.classList.toggle('is-urgent', left < 5000);
  });
}

function renderAnswerButtons(answers) {
  if (answerButtons.childElementCount === answers.length && !sending) return; // уже на экране
  answerButtons.className = `answer-buttons answers-${answers.length}`;
  answerButtons.classList.toggle('has-long-answers', answers.some((text) => [...text].length > 24));
  answerButtons.replaceChildren(...answers.map((text, index) =>
    h('button', {
      class: `answer-button answer-${index}`,
      type: 'button',
      'aria-label': `${ANSWER_SHAPES[index].name}: ${text}`,
      onclick: () => submitAnswer(index),
    },
    shapeIcon(index, 'shape answer-shape'),
    h('span', { class: 'answer-text', text }),
    ),
  ));
}

function runCountdown(remainingMs, paint) {
  cancelAnimationFrame(timerFrame);
  const deadline = performance.now() + Math.max(0, remainingMs);
  const tick = () => {
    const left = Math.max(0, deadline - performance.now());
    paint(left);
    if (left > 0) timerFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  cancelAnimationFrame(timerFrame);
}

// ----- Ответ вручную -----

function updateTextCounter() {
  const length = [...textInput.value].length;
  textCounter.textContent = `${length}/${textInput.maxLength}`;
  textForm.classList.toggle('is-empty', !textInput.value.trim());
  // Пустой ответ кнопка не блокирует: по нажатию (и по Enter) подсказываем, что нужно написать.
  textSubmit.disabled = sending;
}

function setTextHint(message, isError = false) {
  textHint.textContent = message;
  textHint.classList.toggle('is-error', isError);
  if (isError) {
    textHint.classList.remove('shake');
    void textHint.offsetWidth;
    textHint.classList.add('shake');
  }
}

function setTextLocked(locked) {
  textInput.readOnly = locked;
  textSubmit.textContent = locked ? 'Отправляем…' : 'Ответить';
  textForm.classList.toggle('is-sending', locked);
  updateTextCounter();
}

textInput.addEventListener('input', () => {
  updateTextCounter();
  if (textHint.classList.contains('is-error')) setTextHint(TEXT_HINT);
});

textForm.addEventListener('submit', (event) => {
  event.preventDefault();
  const value = textInput.value.replace(/\s+/g, ' ').trim();
  if (!value) {
    setTextHint('Сначала напишите ответ', true);
    textInput.focus();
    return;
  }
  submitAnswer(value);
});

// ----- Отправка ответа -----

function lockChoice(index, locked) {
  [...answerButtons.children].forEach((button, i) => {
    button.disabled = locked;
    button.classList.toggle('is-chosen', locked && i === index);
    button.classList.toggle('is-faded', locked && i !== index);
  });
}

function unlockAnswer(isText, message) {
  sending = false;
  if (isText) {
    setTextLocked(false);
    setTextHint(message, true);
    textInput.focus({ preventScroll: true });
  } else {
    lockChoice(null, false);
    flashToast(message);
  }
}

async function submitAnswer(value) {
  if (sending || !question || question.phase !== 'answering') return;
  const { index: questionIndex, type } = question;
  const isText = type === 'text';
  sending = true;
  vibrate(30);
  if (isText) setTextLocked(true);
  else lockChoice(value, true);

  // Если ответ был последним, сервер присылает результаты раньше подтверждения —
  // тогда экран «Ответ принят» уже не нужен.
  const stillThisQuestion = () => question?.index === questionIndex;
  const accepted = () => {
    sending = false;
    myAnswer = { index: questionIndex, value };
    showAnswered(value);
  };
  try {
    await request(socket, 'player:answer', { questionIndex, answer: value }, { timeoutMs: 10_000 });
    if (stillThisQuestion()) accepted();
  } catch (error) {
    if (!stillThisQuestion()) return;
    switch (error.code) {
      case 'ALREADY_ANSWERED':
        accepted();
        break;
      case 'TOO_LATE':
        sending = false;
        showMessage({ title: 'Время вышло', text: 'Ответ не успел дойти. Ждём результатов…', icon: '⏱' });
        break;
      case 'TOO_EARLY':
        unlockAnswer(isText, isText ? 'Подождите секунду — ответы ещё не открыты' : 'Варианты ещё не открылись — подождите секунду');
        break;
      default:
        // Ответ не дошёл (например, пропала связь) — даём попробовать ещё раз.
        unlockAnswer(isText, error.message);
    }
  }
}

function showAnswered(value) {
  const isText = typeof value === 'string';
  const quote = $('answered-quote');
  if (isText) {
    $('answered-shape').replaceChildren(h('div', { class: 'answered-badge answered-badge-text' }, pencilIcon('shape')));
    quote.textContent = `«${value}»`;
    quote.hidden = false;
  } else {
    $('answered-shape').replaceChildren(h('div', { class: `answered-badge answer-${value}` }, shapeIcon(value, 'shape')));
    const label = question?.answers?.[value];
    quote.textContent = label ? `«${label}»` : '';
    quote.hidden = !label;
  }
  show('view-answered');
}

// ---------- Результат вопроса ----------

function rankText(rank, playerCount) {
  if (!rank) return '';
  if (rank === 1) return playerCount > 1 ? 'Вы лидируете! 🔥' : '1-е место';
  return `${rank}-е место из ${playerCount}`;
}

function resultDetails(result) {
  const lines = [];
  if (result.type === 'text') {
    const accepted = Array.isArray(result.accepted) ? result.accepted : [];
    if (result.answered && typeof result.answer === 'string') {
      lines.push(h('p', { class: 'result-line' },
        h('span', { class: 'result-label', text: 'Ваш ответ' }),
        h('span', { class: `answer-quote ${result.correct ? 'is-correct' : 'is-wrong'}`, text: `«${result.answer}»` }),
      ));
    }
    if (accepted.length) {
      lines.push(h('p', { class: 'result-line' },
        h('span', { class: 'result-label', text: 'Правильный ответ' }),
        h('span', { class: 'correct-chip correct-chip-text', text: accepted[0] }),
      ));
      if (accepted.length > 1) lines.push(h('p', { class: 'result-also', text: `также: ${accepted.slice(1).join(', ')}` }));
    }
    return lines;
  }

  if (!result.correct && Number.isInteger(result.correctIndex)) {
    lines.push(h('p', { class: 'result-line' },
      h('span', { class: 'result-label', text: 'Правильный ответ' }),
      h('span', { class: `correct-chip answer-${result.correctIndex}` },
        shapeIcon(result.correctIndex, 'shape'),
        h('span', { text: result.correctText }),
      ),
    ));
  } else if (result.correct && result.score !== null && result.score !== undefined) {
    lines.push(h('p', { class: 'result-total', text: `Всего: ${formatScore(result.score)} ${plural(result.score, ['очко', 'очка', 'очков'])}` }));
  }
  return lines;
}

function renderResult(result) {
  question = null;
  sending = false;
  // После последнего вопроса сервер скрывает счёт и место до церемонии награждения.
  const hiddenStandings = result.score === null || result.score === undefined || result.rank === null || result.rank === undefined;
  if (!hiddenStandings) setScore(result.score);

  const icon = $('result-icon');
  const title = $('result-title');
  const points = $('result-points');
  let mood;
  if (!result.answered) {
    mood = 'timeout';
    icon.textContent = '⏱';
    title.textContent = 'Время вышло';
    points.textContent = '+0';
  } else if (result.correct) {
    mood = 'correct';
    icon.textContent = '✓';
    title.textContent = 'Верно!';
    points.textContent = `+${formatScore(result.points)}`;
    vibrate([40, 60, 40]);
  } else {
    mood = 'wrong';
    icon.textContent = '✕';
    title.textContent = 'Неверно';
    points.textContent = '+0';
    vibrate(150);
  }

  $('result-details').replaceChildren(...resultDetails(result));
  const rank = $('result-rank');
  rank.textContent = hiddenStandings ? '' : rankText(result.rank, result.playerCount);
  rank.hidden = hiddenStandings || !rank.textContent;
  $('result-hidden').hidden = !hiddenStandings;
  show('view-result', mood);
}

// ---------- Церемония и финал ----------

function showCeremony() {
  question = null;
  shownFinal = null;
  setScore(null);
  show('view-ceremony', 'ceremony');
}

const MEDAL_TONES = ['gold', 'silver', 'bronze'];

function medal(rank) {
  const tone = MEDAL_TONES[rank - 1] || 'plain';
  return h('div', { class: `medal medal-${tone}` },
    tone === 'plain' ? null : h('span', { class: 'medal-ribbon' }),
    h('span', { class: 'medal-disc' }, h('span', { class: 'medal-number', text: rank })),
  );
}

function podiumList(podium) {
  const me = playerState.get().nickname;
  return (podium || []).map((row, index) =>
    h('li', { class: row.nickname === me ? 'is-me' : null, style: `animation-delay: ${index * 90}ms` },
      h('span', { class: `podium-rank podium-rank-${MEDAL_TONES[row.rank - 1] || 'plain'}`, text: row.rank }),
      h('span', { class: 'podium-name', text: row.nickname }),
      h('span', { class: 'podium-score', text: formatScore(row.score) }),
    ));
}

function showPodium(final) {
  $('final-podium').replaceChildren(...podiumList(final.podium));
  $('final-podium-wrap').hidden = !final.podium?.length;
  const note = $('final-note');
  if (!note.dataset.closed) note.hidden = true;
  $('play-again').hidden = false;
  $('final-caption').textContent = 'Игра окончена';
}

function launchConfetti() {
  const layer = $('confetti');
  const colors = ['var(--a0)', 'var(--a1)', 'var(--a2)', 'var(--a3)', '#ffd166', '#ffffff'];
  layer.replaceChildren(...Array.from({ length: 36 }, (_, i) => h('span', {
    style: [
      `--x: ${Math.round(Math.random() * 100)}%`,
      `--drift: ${Math.round((Math.random() - 0.5) * 120)}px`,
      `--spin: ${Math.round(360 + Math.random() * 540)}deg`,
      `--delay: ${Math.round(Math.random() * 600)}ms`,
      `--fall: ${(2.2 + Math.random() * 1.6).toFixed(2)}s`,
      `--color: ${colors[i % colors.length]}`,
    ].join(';'),
  })));
  clearTimeout(launchConfetti.timer);
  launchConfetti.timer = setTimeout(() => layer.replaceChildren(), 4800);
}

function renderFinal(final) {
  question = null;
  setScore(final.score);
  const complete = Boolean(final.complete);

  // Своё место уже на экране — не повторяем большую анимацию, только добавляем пьедестал.
  if (currentView === 'view-final' && shownFinal?.rank === final.rank) {
    if (complete && !shownFinal.complete) showPodium(final);
    shownFinal = { rank: final.rank, complete: shownFinal.complete || complete };
    return;
  }

  const onPodium = final.rank >= 1 && final.rank <= 3;
  const place = $('final-place');
  place.className = `final-place ${onPodium ? 'is-podium' : ''}`;
  place.replaceChildren(h('span', { class: 'final-rays' }), medal(final.rank));
  $('final-caption').textContent = complete ? 'Игра окончена' : 'Ваше место';
  $('final-rank').textContent = `${final.rank} место`;
  $('final-summary').textContent =
    `из ${final.playerCount} ${plural(final.playerCount, ['игрока', 'игроков', 'игроков'])} · ${formatScore(final.score)} ${plural(final.score, ['очко', 'очка', 'очков'])} · верно ${final.correctCount} из ${final.totalQuestions}`;

  const note = $('final-note');
  delete note.dataset.closed;
  if (complete) {
    showPodium(final);
  } else {
    $('final-podium-wrap').hidden = true;
    $('play-again').hidden = true;
    note.textContent = 'Церемония продолжается — смотрите на экран ведущего';
    note.hidden = false;
  }

  show('view-final', onPodium ? `winner rank-${final.rank}` : 'final');
  if (onPodium) {
    launchConfetti();
    vibrate([80, 60, 80, 60, 240]);
  }
  shownFinal = { rank: final.rank, complete };
}

// ---------- Снимок состояния (вход и переподключение) ----------

function applySnapshot(snapshot) {
  setScore(snapshot.score);
  switch (snapshot.state) {
    case 'lobby':
      showWaiting(snapshot.playerCount);
      break;
    case 'question':
      if (snapshot.question) renderQuestion(snapshot.question, snapshot.myAnswer);
      break;
    case 'results':
      if (snapshot.result) renderResult(snapshot.result);
      break;
    case 'final':
      if (snapshot.final) renderFinal(snapshot.final);
      else showCeremony();
      break;
    default:
      showWaiting(snapshot.playerCount);
  }
}

// ---------- Подключение ----------

function stopForGood() {
  finished = true;
  clearTimeout(retryTimer);
  hideBanner();
  socket?.disconnect();
  releaseWakeLock();
}

async function joinFresh() {
  const current = playerState.get();
  const response = await request(socket, 'player:join', {
    code: current.code,
    nickname: current.nickname,
    photo: current.photo,
  }, { timeoutMs: 45_000 }); // ждём долго: повторный вход без ответа сервера займёт ник «призраком»
  playerState.patch({ playerId: response.playerId, token: response.token, nickname: response.nickname });
  return response;
}

async function enterRoom() {
  const current = playerState.get();
  if (current.token) {
    try {
      return await request(socket, 'player:rejoin', { code: current.code, token: current.token }, { timeoutMs: 20_000 });
    } catch (error) {
      if (error.code !== 'PLAYER_NOT_FOUND' || !current.nickname || !current.photo) throw error;
      playerState.patch({ token: null, playerId: null });
    }
  }
  return joinFresh();
}

function handleJoinError(error) {
  switch (error.code) {
    case 'NICKNAME_TAKEN':
    case 'BAD_NICKNAME':
      stopForGood();
      goTo('name.html', error.message);
      return;
    case 'BAD_PHOTO':
      stopForGood();
      playerState.patch({ photo: null });
      goTo('photo.html', error.message);
      return;
    case 'ROOM_NOT_FOUND':
    case 'BAD_CODE':
      if (currentView === 'view-final') {
        roomGone('Ведущий закрыл комнату. Спасибо за игру!');
        return;
      }
      stopForGood();
      playerState.leaveRoom();
      goTo('index.html', error.message);
      return;
    case 'GAME_STARTED':
    case 'ROOM_FULL':
    case 'PLAYER_NOT_FOUND':
      stopForGood();
      playerState.leaveRoom();
      showMessage({ title: 'Не получилось войти', text: error.message, actions: [homeButton()] });
      return;
    default:
      stopForGood();
      showMessage({ title: 'Ошибка подключения', text: error.message, actions: [retryButton(), homeButton()] });
  }
}

/** Временная ошибка: показываем «Переподключаемся…» и пробуем снова через 1, 2, 4… максимум 10 секунд. */
function scheduleRetry(error) {
  const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** retryAttempt);
  retryAttempt += 1;
  showBanner(error.code === 'RATE_LIMIT' ? 'Сервер занят. Пробуем ещё раз…' : 'Связь потеряна. Переподключаемся…');
  clearTimeout(retryTimer);
  retryTimer = setTimeout(() => {
    if (finished || !socket) return;
    if (!socket.connected) {
      // Socket.IO переподключается сам; если он остановился — запускаем заново.
      if (!socket.active) socket.connect();
    } else if (error.code === 'TIMEOUT' || error.code === 'CONFLICT') {
      // Ответ мог потеряться, а вход — состояться: начинаем с чистого соединения.
      forceReconnect();
    } else {
      onConnect();
    }
  }, delay);
}

/** Немедленно открыть новое соединение (после сна телефона, смены сети, «зависшего» сокета). */
function forceReconnect() {
  if (finished || !socket) return;
  clearTimeout(retryTimer);
  entered = false;
  entering = false;
  connectSeq += 1;
  showBanner('Переподключаемся…');
  socket.disconnect(); // событие disconnect с причиной «io client disconnect» не считается ошибкой
  socket.connect();
}

function queueOr(handler) {
  return (payload) => {
    if (finished) return;
    if (entering) queuedEvents.push(() => handler(payload));
    else handler(payload);
  };
}

async function onConnect() {
  if (finished) return;
  clearTimeout(retryTimer);
  const seq = ++connectSeq;
  entered = false;
  entering = true;
  queuedEvents = [];
  try {
    const response = await enterRoom();
    if (seq !== connectSeq || finished) return;
    entered = true;
    entering = false;
    retryAttempt = 0;
    hideBanner();
    renderHeader();
    applySnapshot(response.snapshot);
    const events = queuedEvents;
    queuedEvents = [];
    events.forEach((apply) => apply());
    requestWakeLock();
  } catch (error) {
    if (seq !== connectSeq || finished) return;
    entering = false;
    queuedEvents = [];
    if (TRANSIENT_CODES.has(error.code)) scheduleRetry(error);
    else handleJoinError(error);
  }
}

/**
 * Проверка «живости» после возврата на вкладку: телефон мог уснуть или сменить сеть, а сокет ещё
 * считает себя подключённым. Повторный player:rejoin на живом соединении сразу отвечает CONFLICT
 * («Вы уже в игре»); если ответа нет — соединение мёртвое, открываем новое.
 */
async function checkConnection() {
  const current = playerState.get();
  if (!current.token || !entered) return;
  const seq = connectSeq;
  try {
    const response = await request(socket, 'player:rejoin', { code: current.code, token: current.token }, { timeoutMs: 5000 });
    if (seq === connectSeq && !finished) applySnapshot(response.snapshot); // сервер забыл соединение — вернулись заново
  } catch (error) {
    if (seq !== connectSeq || finished) return;
    if (error.code === 'TIMEOUT') forceReconnect();
  }
}

function roomGone(text) {
  stopForGood();
  playerState.leaveRoom();
  const note = $('final-note');
  note.textContent = text;
  note.dataset.closed = 'true';
  note.hidden = false;
  $('play-again').hidden = false;
}

function bindEvents() {
  socket.on('connect', onConnect);

  socket.on('disconnect', (reason) => {
    entered = false;
    if (finished || reason === 'io client disconnect') return;
    showBanner();
    if (reason === 'io server disconnect') socket.connect(); // сервер закрыл соединение — Socket.IO сам не вернётся
  });
  socket.on('connect_error', () => {
    if (finished) return;
    showBanner();
    if (!socket.active) scheduleRetry({ code: 'DISCONNECTED' });
  });

  socket.on('lobby:update', queueOr(({ count }) => {
    $('wait-count').textContent = `Игроков в комнате: ${count}`;
  }));

  socket.on('game:started', queueOr(() => {
    showMessage({ title: 'Поехали!', text: 'Первый вопрос уже на экране', icon: '🚀' });
  }));
  socket.on('question', queueOr((data) => renderQuestion(data)));
  socket.on('results', queueOr(renderResult));
  socket.on('game:ceremony', queueOr(showCeremony));
  socket.on('game:end', queueOr(renderFinal));

  socket.on('room:closed', ({ message, finished: gameFinished, reason }) => {
    if (gameFinished && currentView === 'view-final') {
      roomGone('Ведущий закрыл комнату. Спасибо за игру!');
      return;
    }
    stopForGood();
    playerState.leaveRoom();
    showMessage({
      title: reason === 'replaced' ? 'Игра открыта в другом месте' : 'Игра завершена',
      text: message,
      icon: reason === 'replaced' ? '📱' : '👋',
      actions: [homeButton()],
    });
  });

  socket.on('player:kicked', ({ message }) => {
    stopForGood();
    playerState.leaveRoom();
    showMessage({ title: 'Вы покинули игру', text: message, icon: '🚪', actions: [homeButton('Войти снова')] });
  });

  socket.on('error', ({ message }) => console.warn('[server]', message));
}

// ---------- Экран не гаснет во время игры ----------

async function requestWakeLock() {
  try {
    if ('wakeLock' in navigator && document.visibilityState === 'visible' && !wakeLock) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => {
        wakeLock = null;
      });
    }
  } catch {
    /* не поддерживается или запрещено — не страшно */
  }
}

function releaseWakeLock() {
  wakeLock?.release().catch(() => {});
  wakeLock = null;
}

// ---------- Возврат на вкладку, смена сети ----------

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    hiddenAt = Date.now();
    return;
  }
  if (finished) return;
  requestWakeLock();
  if (!socket) return;
  if (!socket.connected) forceReconnect();
  else if (Date.now() - hiddenAt > 2000) checkConnection();
});

window.addEventListener('online', () => {
  if (!finished && socket && !socket.connected) forceReconnect();
});

// Страница восстановлена из кэша «назад/вперёд» — соединение точно нужно открыть заново.
window.addEventListener('pageshow', (event) => {
  if (event.persisted && !finished && socket && !socket.connected) forceReconnect();
});

// ---------- Старт ----------

async function start() {
  let attempt = 0;
  while (!socket) {
    try {
      socket = await connectPlayer();
    } catch {
      // Скрипт клиента не загрузился (нет сети, сервер просыпается) — пробуем снова, не сдаёмся.
      const delay = Math.min(MAX_RETRY_DELAY_MS, 1000 * 2 ** attempt);
      attempt += 1;
      $('connecting-text').textContent = 'Не удаётся связаться с сервером. Пробуем снова…';
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  bindEvents();
}

if (guard()) {
  renderHeader();
  show('view-connecting');
  start();
}
