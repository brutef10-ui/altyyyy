// Экран игрока: ожидание старта → 4 цветные кнопки ответа → результат после каждого вопроса → финал.
// Очки и время считает сервер; здесь только отображение.
import { goTo, playerState } from './session.js';
import { connectPlayer, request } from './socket.js';
import { ANSWER_SHAPES, formatScore, h, plural, shapeIcon, vibrate } from './ui.js';

const state = playerState.get();

const views = [...document.querySelectorAll('.view')];
const reconnectBanner = document.getElementById('reconnect');
const scoreValue = document.getElementById('me-score');
const answerButtons = document.getElementById('answer-buttons');
const timebar = document.getElementById('timebar');
const secondsValue = document.getElementById('q-seconds');

let socket = null;
let finished = false; // комната закрыта, игрок удалён или ошибка — не переподключаемся
let question = null;
let answering = false;
let timerFrame = 0;
let wakeLock = null;

// ---------- Проверка шагов входа ----------

function guard() {
  let redirect = null;
  if (!state.code) redirect = ['index.html', 'Введите код комнаты'];
  else if (state.token) return true; // можно вернуться в игру после перезагрузки страницы
  else if (!state.photo) redirect = ['photo.html', 'Сначала сделайте селфи'];
  else if (!state.nickname) redirect = ['name.html'];
  if (!redirect) return true;
  goTo(...redirect);
  return false;
}

// ---------- Экраны ----------

function show(id, mood = '') {
  for (const view of views) view.hidden = view.id !== id;
  const current = document.getElementById(id);
  current.classList.remove('enter');
  void current.offsetWidth;
  current.classList.add('enter');
  document.body.dataset.mood = mood;
  if (id !== 'view-question') stopTimer();
}

function setScore(score) {
  scoreValue.textContent = formatScore(score);
}

function renderHeader() {
  const current = playerState.get();
  const avatar = document.getElementById('me-avatar');
  if (current.photo) {
    avatar.src = current.photo;
    document.getElementById('wait-avatar').src = current.photo;
  } else {
    avatar.hidden = true;
  }
  document.getElementById('me-name').textContent = current.nickname || '';
}

function showWaiting(count) {
  document.getElementById('wait-count').textContent = `Игроков в комнате: ${count}`;
  show('view-waiting');
}

function showMessage({ title, text, icon = '!', actions = [] }) {
  document.getElementById('message-icon').textContent = icon;
  document.getElementById('message-title').textContent = title;
  document.getElementById('message-text').textContent = text;
  document.getElementById('message-actions').replaceChildren(...actions);
  show('view-message', 'neutral');
}

const homeButton = (label = 'На главную') =>
  h('a', { class: 'btn btn-primary btn-block', href: 'index.html', text: label });
const retryButton = () =>
  h('button', { class: 'btn btn-ghost btn-block', type: 'button', text: 'Попробовать снова', onclick: () => location.reload() });

// ---------- Вопрос ----------

function renderQuestion(data, myAnswer = null) {
  question = data;
  answering = false;
  document.getElementById('q-number').textContent = `Вопрос ${data.index + 1} из ${data.totalQuestions}`;
  document.getElementById('q-text').textContent = data.text;

  answerButtons.className = `answer-buttons answers-${data.answers.length}`;
  answerButtons.replaceChildren(...data.answers.map((text, index) =>
    h('button', {
      class: `answer-button answer-${index}`,
      type: 'button',
      'aria-label': `${ANSWER_SHAPES[index].name}: ${text}`,
      onclick: () => answer(index),
    },
    shapeIcon(index, 'shape answer-shape'),
    h('span', { class: 'answer-text', text }),
    ),
  ));

  if (myAnswer !== null && myAnswer !== undefined) {
    showAnswered(myAnswer);
    return;
  }
  show('view-question');
  startTimer(data.remainingMs, data.timeLimit * 1000);
}

function startTimer(remainingMs, totalMs) {
  cancelAnimationFrame(timerFrame);
  const deadline = performance.now() + remainingMs;
  const tick = () => {
    const left = Math.max(0, deadline - performance.now());
    secondsValue.textContent = Math.ceil(left / 1000);
    timebar.style.transform = `scaleX(${left / totalMs})`;
    timebar.classList.toggle('is-urgent', left < 5000);
    if (left > 0) timerFrame = requestAnimationFrame(tick);
  };
  tick();
}

function stopTimer() {
  cancelAnimationFrame(timerFrame);
}

function showAnswered(index) {
  document.getElementById('answered-shape').replaceChildren(
    h('div', { class: `answered-badge answer-${index}` }, shapeIcon(index, 'shape')),
  );
  show('view-answered');
}

async function answer(index) {
  if (answering || !question) return;
  answering = true;
  vibrate(30);
  const buttons = [...answerButtons.children];
  buttons.forEach((button, i) => {
    button.disabled = true;
    button.classList.toggle('is-chosen', i === index);
    button.classList.toggle('is-faded', i !== index);
  });

  const questionIndex = question.index;
  // Если ответ был последним, сервер присылает результаты раньше подтверждения —
  // тогда экран «Ответ принят» уже не нужен.
  const stillThisQuestion = () => question?.index === questionIndex;
  try {
    await request(socket, 'player:answer', { questionIndex, answer: index });
    if (stillThisQuestion()) showAnswered(index);
  } catch (error) {
    if (!stillThisQuestion()) return;
    if (error.code === 'ALREADY_ANSWERED') {
      showAnswered(index);
    } else if (error.code === 'TOO_LATE') {
      showMessage({ title: 'Время вышло', text: 'Ответ не успел дойти. Ждём результатов…', icon: '⏱' });
    } else {
      // Ответ не дошёл (например, пропала связь) — даём попробовать ещё раз.
      answering = false;
      buttons.forEach((button) => {
        button.disabled = false;
        button.classList.remove('is-chosen', 'is-faded');
      });
      flashToast(error.message);
    }
  }
}

function flashToast(message) {
  const toast = h('div', { class: 'toast', role: 'status', text: message });
  document.body.append(toast);
  setTimeout(() => toast.remove(), 3500);
}

// ---------- Результат вопроса ----------

function rankText(rank, playerCount) {
  if (!rank) return '';
  if (rank === 1) return playerCount > 1 ? 'Вы лидируете! 🔥' : '1-е место';
  return `${rank}-е место из ${playerCount}`;
}

function renderResult(result) {
  question = null;
  setScore(result.score);
  const icon = document.getElementById('result-icon');
  const title = document.getElementById('result-title');
  const points = document.getElementById('result-points');
  const correct = document.getElementById('result-correct');

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

  correct.replaceChildren();
  if (!result.correct) {
    correct.append('Правильный ответ: ', h('span', { class: `correct-chip answer-${result.correctIndex}` },
      shapeIcon(result.correctIndex, 'shape'),
      h('span', { text: result.correctText }),
    ));
  } else {
    correct.textContent = `Всего: ${formatScore(result.score)} ${plural(result.score, ['очко', 'очка', 'очков'])}`;
  }
  document.getElementById('result-rank').textContent = rankText(result.rank, result.playerCount);
  show('view-result', mood);
}

// ---------- Финал ----------

function renderFinal(final) {
  question = null;
  setScore(final.score);
  const medal = ['🥇', '🥈', '🥉'][final.rank - 1] || '🎯';
  document.getElementById('final-place').replaceChildren(
    h('span', { class: 'final-medal', text: medal }),
    h('span', { class: 'final-rank', text: `${final.rank} место` }),
  );
  document.getElementById('final-summary').textContent =
    `из ${final.playerCount} ${plural(final.playerCount, ['игрока', 'игроков', 'игроков'])} · ${formatScore(final.score)} очков · верно ${final.correctCount} из ${final.totalQuestions}`;
  document.getElementById('final-podium').replaceChildren(...final.podium.map((row) =>
    h('li', {}, h('span', { class: 'podium-rank', text: row.rank }), h('span', { class: 'podium-name', text: row.nickname }), h('span', { class: 'podium-score', text: formatScore(row.score) })),
  ));
  show('view-final', final.rank <= 3 ? 'winner' : 'neutral');
  if (final.rank <= 3) vibrate([60, 80, 60, 80, 120]);
}

// ---------- Снимок состояния (вход и переподключение) ----------

function applySnapshot(snapshot) {
  setScore(snapshot.score);
  switch (snapshot.state) {
    case 'lobby':
      showWaiting(snapshot.playerCount);
      break;
    case 'question':
      renderQuestion(snapshot.question, snapshot.myAnswer);
      break;
    case 'results':
      renderResult(snapshot.result);
      break;
    case 'final':
      renderFinal(snapshot.final);
      break;
    default:
      showWaiting(snapshot.playerCount);
  }
}

// ---------- Подключение ----------

function stopForGood() {
  finished = true;
  reconnectBanner.hidden = true;
  socket?.disconnect();
  releaseWakeLock();
}

async function joinFresh() {
  const current = playerState.get();
  const response = await request(socket, 'player:join', {
    code: current.code,
    nickname: current.nickname,
    photo: current.photo,
  });
  playerState.patch({ playerId: response.playerId, token: response.token, nickname: response.nickname });
  return response;
}

async function enterRoom() {
  const current = playerState.get();
  if (current.token) {
    try {
      return await request(socket, 'player:rejoin', { code: current.code, token: current.token });
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

async function onConnect() {
  reconnectBanner.hidden = true;
  try {
    const response = await enterRoom();
    renderHeader();
    applySnapshot(response.snapshot);
    requestWakeLock();
  } catch (error) {
    handleJoinError(error);
  }
}

function bindEvents() {
  socket.on('connect', onConnect);

  socket.on('disconnect', (reason) => {
    if (finished || reason === 'io client disconnect') return;
    reconnectBanner.hidden = false;
  });
  socket.on('connect_error', () => {
    if (!finished) reconnectBanner.hidden = false;
  });

  socket.on('lobby:update', ({ count }) => {
    const label = document.getElementById('wait-count');
    if (label) label.textContent = `Игроков в комнате: ${count}`;
  });

  socket.on('game:started', () => {
    showMessage({ title: 'Поехали!', text: 'Первый вопрос уже на экране', icon: '🚀' });
  });
  socket.on('question', (data) => renderQuestion(data));
  socket.on('results', renderResult);
  socket.on('game:end', (final) => {
    renderFinal(final);
  });

  socket.on('room:closed', ({ message, finished: gameFinished, reason }) => {
    const onFinal = !document.getElementById('view-final').hidden;
    stopForGood();
    playerState.leaveRoom();
    if (gameFinished && onFinal) {
      const note = document.getElementById('final-note');
      note.textContent = 'Ведущий закрыл комнату. Спасибо за игру!';
      note.hidden = false;
      return;
    }
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

document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && !finished) requestWakeLock();
});

// ---------- Старт ----------

if (guard()) {
  renderHeader();
  show('view-connecting');
  try {
    socket = await connectPlayer();
    bindEvents();
  } catch (error) {
    showMessage({ title: 'Нет связи', text: error.message, actions: [retryButton(), homeButton()] });
  }
}
