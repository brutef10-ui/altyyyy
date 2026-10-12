// Экран игры на проекторе: вопрос, таймер, счётчик ответов, результаты вопроса.
// Таймер здесь только показывает время — решает, когда вопрос закончился, сервер.
import { openHostRoom, request } from './socket.js';
import { avatar, formatCode, formatScore, h, plural, shapeIcon, toast } from './ui.js';

const RING_LENGTH = 2 * Math.PI * 54;

const gameView = document.getElementById('game');
const questionBanner = document.getElementById('question-banner');
const questionText = document.getElementById('question-text');
const counter = document.getElementById('q-counter');
const answeredValue = document.getElementById('answered');
const answeredLabel = document.getElementById('answered-label');
const answersGrid = document.getElementById('answers');
const timerBox = document.getElementById('timer');
const timerValue = document.getElementById('timer-value');
const timerProgress = document.getElementById('timer-progress');
const resultsPanel = document.getElementById('results-panel');
const barsBox = document.getElementById('bars');
const leaderList = document.getElementById('leaderboard');
const nextButton = document.getElementById('next');
const phaseHint = document.getElementById('phase-hint');

const players = new Map(); // id → { nickname, avatar }
let socket = null;
let state = null;
let current = null; // текущий вопрос (данные для ведущего)
let timerFrame = 0;
let busy = false;

timerProgress.style.strokeDasharray = `${RING_LENGTH}`;

// ---------- Вопрос ----------

function restartAnimation(node, className) {
  node.classList.remove(className);
  void node.offsetWidth;
  node.classList.add(className);
}

function renderQuestion(question) {
  state = 'question';
  current = question;
  gameView.hidden = false;
  counter.textContent = `Вопрос ${question.index + 1} из ${question.totalQuestions}`;
  questionText.textContent = question.text;
  restartAnimation(questionBanner, 'enter');

  renderTiles(question);

  resultsPanel.hidden = true;
  timerBox.hidden = false;
  updateProgress(question);
  startTimer(question.remainingMs, question.timeLimit * 1000);
  setNextButton('Завершить вопрос', 'Вопрос закончится сам, когда выйдет время или ответят все');
}

function renderTiles(question) {
  answersGrid.className = `answer-grid answers-${question.answers.length}`;
  answersGrid.replaceChildren(...question.answers.map((text, index) =>
    h('div', { class: `answer-tile answer-${index}`, style: { animationDelay: `${index * 70}ms` } },
      shapeIcon(index, 'shape tile-shape'),
      h('span', { class: 'tile-text', text }),
      h('span', { class: 'tile-count', hidden: true }),
    ),
  ));
}

function updateProgress({ answered, playerCount }) {
  answeredValue.textContent = answered;
  answeredLabel.textContent = `из ${playerCount} ${plural(playerCount, ['ответил', 'ответили', 'ответили'])}`;
  restartAnimation(answeredValue, 'bump');
}

// ---------- Таймер (только отображение) ----------

function startTimer(remainingMs, totalMs) {
  cancelAnimationFrame(timerFrame);
  const deadline = performance.now() + remainingMs;
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

function renderResults(results, question = current) {
  state = 'results';
  stopTimer();
  if (question) {
    // Страница могла открыться сразу на результатах (переподключение) — дорисуем вопрос.
    current = question;
    gameView.hidden = false;
    counter.textContent = `Вопрос ${results.index + 1} из ${results.totalQuestions}`;
    questionText.textContent = question.text;
    if (answersGrid.children.length !== question.answers.length) renderTiles(question);
  }

  [...answersGrid.children].forEach((tile, index) => {
    tile.classList.toggle('is-correct', index === results.correctIndex);
    tile.classList.toggle('is-dimmed', index !== results.correctIndex);
    const count = tile.querySelector('.tile-count');
    count.hidden = false;
    count.textContent = results.counts[index];
  });

  const max = Math.max(1, ...results.counts);
  barsBox.replaceChildren(...results.counts.map((count, index) =>
    h('div', { class: `bar answer-${index}${index === results.correctIndex ? ' is-correct' : ''}` },
      h('span', { class: 'bar-value', text: count }),
      h('span', { class: 'bar-fill', style: { '--fill': `${(count / max) * 100}%`, animationDelay: `${index * 90}ms` } }),
      h('span', { class: 'bar-label' }, shapeIcon(index, 'shape bar-shape'), index === results.correctIndex ? h('b', { text: '✓' }) : null),
    ),
  ));

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

  answeredValue.textContent = results.answeredCount;
  answeredLabel.textContent = `из ${results.playerCount} ${plural(results.playerCount, ['ответил', 'ответили', 'ответили'])}`;

  timerBox.hidden = true;
  resultsPanel.hidden = false;
  restartAnimation(resultsPanel, 'enter');
  setNextButton(results.isLast ? 'Показать итоги 🏆' : 'Следующий вопрос →', results.isLast ? 'Это был последний вопрос' : 'Пробел или → — следующий вопрос');
}

// ---------- Кнопка «Далее» ----------

function setNextButton(label, hint) {
  nextButton.textContent = label;
  nextButton.disabled = false;
  phaseHint.textContent = hint;
  busy = false;
}

async function next() {
  if (busy || !state) return;
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
    document.title = `Искра — ${snapshot.title}`;
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
  location.href = 'results.html';
});
socket.on('lobby:update', (update) => {
  if (update.action === 'leave') players.delete(update.playerId);
  else if (update.player) players.set(update.player.id, { ...players.get(update.player.id), ...update.player });
});
