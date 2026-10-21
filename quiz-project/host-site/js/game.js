// Экран игры на проекторе: вопрос, время на чтение, таймер, счётчик ответов, результаты вопроса.
// Таймеры здесь только показывают время — когда открыть варианты и закончить вопрос, решает сервер.
//
// Ход вопроса: phase «reading» (только вопрос и картинка) → «answering» (варианты или ввод текста) → results.
// Раскладку экрана задают атрибуты #game: data-phase, data-type и класс has-image (см. css/game.css).
// Новый вопрос — смена декораций «поворотный круг» (theatre.js), чтение → ответы — плавная перестройка (FLIP).
import { imageUrl } from './api.js';
import { openHostRoom, request } from './socket.js';
import { avatar, formatCode, formatScore, h, plural, shapeIcon, toast } from './ui.js';
import { curtain, sceneIn } from './theatre.js';

const RING_LENGTH = 2 * Math.PI * 54;
const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');

const gameView = document.getElementById('game');
const questionBanner = document.getElementById('question-banner');
const questionText = document.getElementById('question-text');
const questionTag = document.getElementById('question-tag');
const questionImage = document.getElementById('question-image');
const counter = document.getElementById('q-counter');
const answeredValue = document.getElementById('answered');
const answeredLabel = document.getElementById('answered-label');
const liveCount = document.getElementById('answers-live-count');
const liveLabel = document.getElementById('answers-live-label');
const answersGrid = document.getElementById('answers');
const timerBox = document.getElementById('timer');
const timerValue = document.getElementById('timer-value');
const timerProgress = document.getElementById('timer-progress');
const readingText = document.getElementById('reading-text');
const readingSeconds = document.getElementById('reading-seconds');
const readingUnit = document.getElementById('reading-unit');
const readingFill = document.getElementById('reading-fill');
const resultsPanel = document.getElementById('results-panel');
const barsBox = document.getElementById('bars');
const leaderCard = document.getElementById('leaderboard-card');
const leaderList = document.getElementById('leaderboard');
const finaleTeaser = document.getElementById('finale-teaser');
const textWait = document.getElementById('text-wait');
const textAnswer = document.getElementById('text-answer');
const textAnswerMain = document.getElementById('text-answer-main');
const textAnswerAlso = document.getElementById('text-answer-also');
const nextButton = document.getElementById('next');
const phaseHint = document.getElementById('phase-hint');

const players = new Map(); // id → { nickname, avatar }
let socket = null;
let state = null;
let current = null; // текущий вопрос (данные для ведущего)
let timerFrame = 0;
let readingFrame = 0;
let busy = false;

timerProgress.style.strokeDasharray = `${RING_LENGTH}`;

// ---------- Вспомогательное ----------

function restartAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

const secondsWord = (seconds) => plural(seconds, ['секунду', 'секунды', 'секунд']);
const answeredWord = (count) => plural(count, ['ответил', 'ответили', 'ответили']);

/**
 * Меняет раскладку экрана и плавно переносит заголовок и картинку на новые места (техника FLIP):
 * запоминаем, где элементы были, меняем раскладку и анимируем переход из старого положения в новое.
 */
function changeLayout(mutate) {
  const tracked = [
    { node: questionBanner, scale: false },
    { node: questionImage, scale: true },
  ].map((item) => ({ ...item, before: item.node.getBoundingClientRect() }));

  mutate();

  if (reducedMotion.matches) return;
  for (const { node, scale, before } of tracked) {
    const after = node.getBoundingClientRect();
    if (!before.width || !before.height || !after.width || !after.height) continue;
    const dx = before.left - after.left;
    const dy = before.top - after.top;
    const sx = scale ? before.width / after.width : 1;
    const sy = scale ? before.height / after.height : 1;
    if (Math.abs(dx) < 1 && Math.abs(dy) < 1 && Math.abs(sx - 1) < 0.01 && Math.abs(sy - 1) < 0.01) continue;
    node.animate(
      [
        { transformOrigin: 'top left', transform: `translate(${dx}px, ${dy}px) scale(${sx}, ${sy})` },
        { transformOrigin: 'top left', transform: 'none' },
      ],
      { duration: 600, easing: 'cubic-bezier(0.2, 0.8, 0.2, 1)' },
    );
  }
}

function setImage(id) {
  if (id) {
    const src = imageUrl(id);
    if (questionImage.getAttribute('src') !== src) questionImage.src = src;
    gameView.classList.add('has-image');
  } else {
    questionImage.removeAttribute('src');
    gameView.classList.remove('has-image');
  }
}

// Картинка не загрузилась — лучше показать вопрос без неё, чем значок «битой» картинки.
questionImage.addEventListener('error', () => gameView.classList.remove('has-image'));

// Общая часть вопроса: текст, картинка, номер. Вызывается при показе нового вопроса.
function showQuestionBase(question) {
  gameView.hidden = false;
  gameView.dataset.type = question.type;
  counter.textContent = `Вопрос ${question.index + 1} из ${question.totalQuestions}`;
  questionText.textContent = question.text;
  // Длинный вопрос — кегль меньше, чтобы табличка не закрывала сцену.
  const length = [...question.text].length;
  questionBanner.dataset.length = length > 150 ? 'xl' : length > 90 ? 'long' : '';
  questionTag.hidden = question.type !== 'text';
  setImage(question.image);
}

// ---------- Вопрос ----------

function renderQuestion(question) {
  const sameQuestion = state === 'question' && current?.index === question.index;
  const fromReading = sameQuestion && current.phase === 'reading' && question.phase === 'answering';
  if (sameQuestion && !fromReading && current.phase === question.phase) {
    // Повтор того же этапа (например, после переподключения) — только сверим таймеры.
    current = question;
    if (question.phase === 'reading') startReading(question);
    else startTimer(question.remainingMs, question.timeLimit * 1000);
    updateProgress(question);
    return;
  }

  state = 'question';
  current = question;
  stopTimer();
  stopReading();

  if (fromReading) {
    // Чтение закончилось: на месте открываем варианты, без перерисовки всей страницы.
    changeLayout(() => showAnswering(question));
    updateProgress(question);
  } else {
    // Новый вопрос — смена декораций: сцена выезжает поворотным кругом,
    // а табличка с вопросом опускается с колосников.
    const wasHidden = gameView.hidden;
    showQuestionBase(question);
    restartAnimation(questionBanner, 'enter');
    if (question.phase === 'reading') showReading(question);
    else showAnswering(question);
    updateProgress(question);
    if (!wasHidden) sceneIn(gameView, 'turntable');
  }
}

function showReading(question) {
  gameView.dataset.phase = 'reading';
  answersGrid.replaceChildren();
  readingText.textContent = question.type === 'text' ? 'Поле для ответа откроется через' : 'Варианты появятся через';
  startReading(question);
  setNextButton(
    question.type === 'text' ? 'Начать приём ответов' : 'Показать варианты',
    'Можно не ждать: пробел или → откроет ответы сразу',
  );
}

function showAnswering(question) {
  gameView.dataset.phase = 'answering';
  gameView.dataset.type = question.type;
  if (question.type === 'choice') renderTiles(question);
  else answersGrid.replaceChildren();
  if (question.type === 'text') restartAnimation(textWait, 'enter');
  restartAnimation(timerBox, 'enter');
  startTimer(question.remainingMs, question.timeLimit * 1000);
  setNextButton('Завершить вопрос', 'Вопрос закончится сам, когда выйдет время или ответят все');
}

function renderTiles(question, { animate = true } = {}) {
  const answers = question.answers || [];
  answersGrid.className = `answer-grid answers-${answers.length}`;
  answersGrid.classList.toggle('has-long-answers', answers.some((text) => [...text].length > 28));
  answersGrid.replaceChildren(...answers.map((text, index) =>
    h('div', { class: `answer-tile answer-${index}${animate ? '' : ' no-enter'}`, style: { animationDelay: `${120 + index * 90}ms` } },
      shapeIcon(index, 'shape tile-shape'),
      h('span', { class: 'tile-text', text }),
      h('span', { class: 'tile-count', hidden: true }),
    ),
  ));
}

function updateProgress({ answered, playerCount }) {
  answeredValue.textContent = answered;
  answeredLabel.textContent = `из ${playerCount} ${answeredWord(playerCount)}`;
  restartAnimation(answeredValue, 'bump');
  // Крупный счётчик справа от картинки (виден, когда у вопроса есть картинка).
  if (liveCount.textContent !== String(answered)) restartAnimation(liveCount, 'bump');
  liveCount.textContent = answered;
  liveLabel.textContent = plural(answered, ['ответ', 'ответа', 'ответов']);
}

// ---------- Время на чтение (только отображение) ----------

function startReading(question) {
  cancelAnimationFrame(readingFrame);
  const totalMs = Math.max(1, (question.readTime || 0) * 1000);
  const deadline = performance.now() + Math.max(0, question.readRemainingMs ?? 0);
  let shown = -1;
  const tick = () => {
    const left = Math.max(0, deadline - performance.now());
    const seconds = Math.ceil(left / 1000);
    if (seconds !== shown) {
      shown = seconds;
      readingSeconds.textContent = seconds;
      readingUnit.textContent = secondsWord(seconds);
    }
    readingFill.style.transform = `scaleX(${Math.min(1, left / totalMs)})`;
    if (left > 0) readingFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopReading() {
  cancelAnimationFrame(readingFrame);
}

// ---------- Таймер (только отображение) ----------

function startTimer(remainingMs, totalMs) {
  cancelAnimationFrame(timerFrame);
  const deadline = performance.now() + Math.max(0, remainingMs ?? 0);
  const tick = () => {
    const left = Math.max(0, deadline - performance.now());
    const seconds = Math.ceil(left / 1000);
    timerValue.textContent = seconds;
    timerProgress.style.strokeDashoffset = `${RING_LENGTH * (1 - left / totalMs)}`;
    timerBox.classList.toggle('is-urgent', left > 0 && seconds <= 5);
    if (left > 0) timerFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  cancelAnimationFrame(timerFrame);
  timerBox.classList.remove('is-urgent');
}

// ---------- Результаты вопроса ----------

function choiceBars(results) {
  const max = Math.max(1, ...results.counts);
  return results.counts.map((count, index) =>
    h('div', { class: `bar answer-${index}${index === results.correctIndex ? ' is-correct' : ''}` },
      h('span', { class: 'bar-value', text: count }),
      h('span', { class: 'bar-fill', style: { '--fill': `${(count / max) * 100}%`, animationDelay: `${index * 90}ms` } }),
      h('span', { class: 'bar-label' }, shapeIcon(index, 'shape bar-shape'), index === results.correctIndex ? h('b', { text: '✓' }) : null),
    ),
  );
}

// Для вопроса с вводом текста: сколько ответили верно, неверно и не ответили вовсе.
function textBars(results) {
  const stats = [
    { key: 'correct', icon: '✓', label: 'Верно', value: results.correctCount ?? 0 },
    { key: 'wrong', icon: '✗', label: 'Неверно', value: results.wrongCount ?? 0 },
    { key: 'none', icon: '—', label: 'Без ответа', value: results.noAnswerCount ?? 0 },
  ];
  const max = Math.max(1, ...stats.map((stat) => stat.value));
  return stats.map((stat, index) =>
    h('div', { class: `bar bar-stat stat-${stat.key}${stat.key === 'correct' ? ' is-correct' : ''}` },
      h('span', { class: 'bar-value', text: stat.value }),
      h('span', { class: 'bar-fill', style: { '--fill': `${(stat.value / max) * 100}%`, animationDelay: `${index * 90}ms` } }),
      h('span', { class: 'bar-label' }, h('b', { class: 'bar-icon', text: stat.icon }), h('span', { text: stat.label })),
    ),
  );
}

function renderTextAnswer(results) {
  const accepted = Array.isArray(results.accepted) ? results.accepted : [];
  textAnswerMain.textContent = accepted[0] ?? '—';
  const others = accepted.slice(1);
  textAnswerAlso.hidden = others.length === 0;
  textAnswerAlso.replaceChildren(
    h('span', { class: 'muted', text: 'также принимается: ' }),
    ...others.flatMap((answer, index) => (index ? [', ', h('b', { text: answer })] : [h('b', { text: answer })])),
  );
  restartAnimation(textAnswer, 'enter');
}

function renderLeaderboard(results) {
  const hidden = Boolean(results.leaderboardHidden);
  leaderCard.hidden = hidden;
  finaleTeaser.hidden = !hidden;
  if (hidden) {
    restartAnimation(finaleTeaser, 'enter');
    return;
  }
  leaderList.replaceChildren(...results.leaderboard.map((row, index) => {
    const player = players.get(row.id);
    return h('li', { class: 'leader-row', style: { animationDelay: `${index * 80}ms` } },
      h('span', { class: 'leader-rank', text: row.rank }),
      avatar(player?.avatar, row.nickname, 'avatar avatar-sm'),
      h('span', { class: 'leader-name', text: row.nickname }),
      row.delta > 0 ? h('span', { class: 'leader-delta', text: `+${row.delta}` }) : null,
      h('span', { class: 'leader-score', text: formatScore(row.score) }),
    );
  }));
  if (results.leaderboard.length === 0) leaderList.append(h('li', { class: 'muted', text: 'Пока никто не набрал очков' }));
}

function renderResults(results, question = current) {
  stopTimer();
  stopReading();
  const type = results.type || question?.type || 'choice';
  const fresh = state !== 'question' || current?.index !== results.index;
  if (question && (fresh || question !== current)) {
    // Страница могла открыться сразу на результатах (переподключение) — дорисуем вопрос.
    showQuestionBase({ ...question, type });
  }
  state = 'results';
  current = question ? { ...question, type } : current;
  gameView.hidden = false;
  gameView.dataset.phase = 'results';
  gameView.dataset.type = type;
  counter.textContent = `Вопрос ${results.index + 1} из ${results.totalQuestions}`;

  if (type === 'choice') {
    const answers = question?.answers || [];
    if (answersGrid.children.length !== answers.length || answersGrid.querySelector('.tile-count') === null) {
      renderTiles(question, { animate: false });
    }
    [...answersGrid.children].forEach((tile, index) => {
      tile.classList.toggle('is-correct', index === results.correctIndex);
      tile.classList.toggle('is-dimmed', index !== results.correctIndex);
      const count = tile.querySelector('.tile-count');
      count.hidden = false;
      count.textContent = results.counts?.[index] ?? 0;
    });
    barsBox.className = 'bars';
    barsBox.replaceChildren(...choiceBars({ ...results, counts: results.counts || [] }));
  } else {
    answersGrid.replaceChildren();
    renderTextAnswer(results);
    barsBox.className = 'bars bars-stats';
    barsBox.replaceChildren(...textBars(results));
  }

  renderLeaderboard(results);

  answeredValue.textContent = results.answeredCount;
  answeredLabel.textContent = `из ${results.playerCount} ${answeredWord(results.playerCount)}`;

  restartAnimation(resultsPanel, 'enter');
  if (results.isLast) {
    setNextButton('К награждению →', 'Это был последний вопрос — места объявим на церемонии');
  } else {
    setNextButton('Следующий вопрос →', 'Пробел или → — следующий вопрос');
  }
}

// ---------- Кнопка «Далее» ----------

function setNextButton(label, hint) {
  nextButton.textContent = label;
  nextButton.disabled = false;
  phaseHint.textContent = hint;
  busy = false;
}

async function next() {
  if (busy || !state || !socket) return;
  if (!socket.connected) {
    toast('Нет связи с сервером — подождите, переподключаемся', 'error');
    return;
  }
  busy = true;
  nextButton.disabled = true;
  try {
    await request(socket, 'host:next');
  } catch (error) {
    toast(error.message, 'error');
    busy = false;
    nextButton.disabled = false;
  }
}

nextButton.addEventListener('click', next);
document.addEventListener('keydown', (event) => {
  if (event.target.closest('input, textarea, select, dialog')) return;
  if (event.repeat) return;
  if (event.key === ' ' || event.key === 'ArrowRight' || event.key === 'PageDown') {
    event.preventDefault();
    next();
  }
});

// ---------- Подключение ----------

socket = await openHostRoom({
  page: 'game.html',
  onReady(snapshot) {
    document.getElementById('room-code').textContent = formatCode(snapshot.code);
    document.title = `Luminous — ${snapshot.title}`;
    players.clear();
    snapshot.players.forEach((player) => players.set(player.id, player));
    if (snapshot.state === 'question') renderQuestion(snapshot.question);
    else if (snapshot.state === 'results') renderResults(snapshot.results, snapshot.question);
  },
});

socket.on('question', renderQuestion);
socket.on('question:progress', (progress) => {
  if (state === 'question' && progress.index === current?.index) updateProgress(progress);
});
socket.on('results', (results) => renderResults(results));
socket.on('game:end', () => {
  curtain.go('results.html');
});
socket.on('lobby:update', (update) => {
  if (update.action === 'leave') players.delete(update.playerId);
  else if (update.player) players.set(update.player.id, { ...players.get(update.player.id), ...update.player });
});
