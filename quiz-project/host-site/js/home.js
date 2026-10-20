// Главная ведущего: список сохранённых игр.
import { api } from './api.js';
import { flash, hostSession } from './session.js';
import { launchGame } from './socket.js';
import { confirmDialog, formatDate, h, plural, toast } from './ui.js';

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
      h('div', { class: 'empty-art', 'aria-hidden': 'true' }, document.querySelector('.brand-mark')?.cloneNode(true) ?? '✦'),
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
      h('h2', { class: 'quiz-card-title', text: quiz.title }),
      h('p', { class: 'muted' }, `${quiz.questionCount} ${plural(quiz.questionCount, ['вопрос', 'вопроса', 'вопросов'])} · изменена ${formatDate(quiz.updatedAt)}`),
    ),
    h('div', { class: 'quiz-card-actions' },
      h('button', { class: 'btn btn-primary', type: 'button', text: '▶ Запустить', onclick: () => launchGame({ quizId: quiz.id }) }),
      h('a', { class: 'btn btn-ghost', href: `editor.html?id=${encodeURIComponent(quiz.id)}`, text: 'Изменить' }),
      h('button', {
        class: 'btn btn-ghost btn-icon',
        type: 'button',
        title: 'Удалить',
        'aria-label': `Удалить игру «${quiz.title}»`,
        text: '🗑',
        onclick: () => remove(quiz, card),
      }),
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

const message = flash.take();
if (message) toast(message.message, message.type, 6000);
showActiveGame();
load();
