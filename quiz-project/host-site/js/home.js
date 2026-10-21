// Главная ведущего: список сохранённых игр.
import { api, forgetDeviceToken } from './api.js';
import { logout, requireAccount } from './auth.js';
import { flash, hostSession } from './session.js';
import { launchGame } from './socket.js';
import { confirmDialog, formatDate, h, plural, stageIcon, toast } from './ui.js';

const list = document.getElementById('quiz-list');
const status = document.getElementById('status');

function showStatus(message, { retry = false } = {}) {
  status.replaceChildren(h('p', { text: message }));
  if (retry) status.append(h('button', { class: 'btn btn-small btn-primary', type: 'button', text: 'Повторить', onclick: load }));
  status.hidden = false;
}

function renderEmpty() {
  list.replaceChildren(
    h('div', { class: 'empty card' },
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, document.querySelector('.brand-mark')?.cloneNode(true) ?? ''),
      h('p', { class: 'kicker', text: 'Сцена свободна' }),
      h('h2', { text: 'Пока нет сохранённых игр' }),
      h('p', { class: 'muted', text: 'Создайте свой квиз или начните с демо-викторины, чтобы посмотреть, как всё работает.' }),
      h('div', { class: 'empty-actions' },
        h('a', { class: 'btn btn-primary', href: 'editor.html', text: '+ Создать игру' }),
        h('a', { class: 'btn btn-ghost', href: 'editor.html?demo=1', text: 'Открыть демо' }),
      ),
    ),
  );
}

function quizCard(quiz) {
  const card = h('article', { class: 'quiz-card card' },
    h('div', { class: 'quiz-card-body' },
      h('p', { class: 'quiz-card-kicker', 'aria-hidden': 'true', text: 'Спектакль-квиз' }),
      h('h2', { class: 'quiz-card-title', text: quiz.title }),
      h('p', { class: 'muted' }, `${quiz.questionCount} ${plural(quiz.questionCount, ['вопрос', 'вопроса', 'вопросов'])} · изменена ${formatDate(quiz.updatedAt)}`),
    ),
    h('div', { class: 'quiz-card-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', onclick: () => launchGame({ quizId: quiz.id }) }, stageIcon('play'), 'Запустить'),
      h('a', { class: 'btn btn-ghost', href: `editor.html?id=${encodeURIComponent(quiz.id)}`, text: 'Изменить' }),
      h('button', {
        class: 'btn btn-ghost btn-icon',
        type: 'button',
        title: 'Удалить',
        'aria-label': `Удалить игру «${quiz.title}»`,
        onclick: () => remove(quiz, card),
      }, stageIcon('trash')),
    ),
  );
  return card;
}

async function remove(quiz, card) {
  const confirmed = await confirmDialog({
    title: 'Удалить игру?',
    message: `«${quiz.title}» будет удалена без возможности восстановления.`,
    confirmText: 'Удалить',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.deleteQuiz(quiz.id);
    card.classList.add('is-removing');
    card.addEventListener('animationend', () => {
      card.remove();
      if (!list.querySelector('.quiz-card')) renderEmpty();
    }, { once: true });
    toast('Игра удалена');
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function load() {
  status.hidden = true;
  list.setAttribute('aria-busy', 'true');
  try {
    const quizzes = await api.listQuizzes();
    if (quizzes.length === 0) renderEmpty();
    else list.replaceChildren(...quizzes.map(quizCard));
  } catch (error) {
    list.replaceChildren();
    showStatus(error.message, { retry: true });
  } finally {
    list.setAttribute('aria-busy', 'false');
  }
}

function showActiveGame() {
  const session = hostSession.get();
  const banner = document.getElementById('active-game');
  if (!session?.code) return;
  document.getElementById('active-code').textContent = session.code;
  banner.hidden = false;
  document.getElementById('forget-game').addEventListener('click', () => {
    hostSession.clear();
    banner.hidden = true;
  });
}

// Вошедший ведущий в шапке и кнопка «Выйти».
async function showAccount() {
  const account = await requireAccount();
  if (!account) return;
  document.getElementById('account-name').textContent = account.login;
  document.getElementById('account-chip').hidden = false;
  const button = document.getElementById('logout');
  button.hidden = false;
  button.addEventListener('click', () => {
    button.disabled = true;
    hostSession.clear();
    logout();
  });
  offerLegacyGames();
}

// Игры, созданные в этом браузере до появления аккаунтов, переносятся в аккаунт по кнопке.
async function offerLegacyGames() {
  let count = 0;
  try {
    count = await api.legacyCount();
  } catch {
    return;
  }
  if (!count) return;
  const banner = document.getElementById('legacy-games');
  document.getElementById('legacy-count').textContent = count;
  banner.hidden = false;
  document.getElementById('claim-legacy').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      const claimed = await api.claimLegacy();
      forgetDeviceToken();
      banner.hidden = true;
      toast(`Перенесено игр: ${claimed}`);
      load();
    } catch (error) {
      event.currentTarget.disabled = false;
      toast(error.message, 'error');
    }
  });
}

const message = flash.take();
if (message) toast(message.message, message.type, 6000);
showAccount();
showActiveGame();
load();
