// Редактор игры: название, вопросы, 2–4 варианта ответа, правильный ответ, время на вопрос.
import { api } from './api.js';
import { editorDraft } from './session.js';
import { launchGame } from './socket.js';
import { ANSWER_SHAPES, confirmDialog, h, plural, shapeIcon, toast } from './ui.js';

// Те же ограничения проверяет сервер (server/src/validate.js).
const LIMITS = {
  titleMax: 80,
  questionsMax: 50,
  questionMax: 200,
  answersMin: 2,
  answersMax: 4,
  answerMax: 80,
  timeLimits: [5, 10, 15, 20, 30, 45, 60, 90, 120],
  defaultTimeLimit: 20,
};

const DEMO_QUIZ = {
  title: 'Разминка: обо всём понемногу',
  questions: [
    { text: 'Какая планета — самая большая в Солнечной системе?', answers: ['Марс', 'Юпитер', 'Сатурн', 'Нептун'], correct: 1, timeLimit: 20 },
    { text: 'Сколько континентов на Земле?', answers: ['5', '6', '7', '8'], correct: 2, timeLimit: 15 },
    { text: 'Кто написал роман в стихах «Евгений Онегин»?', answers: ['Лермонтов', 'Пушкин', 'Толстой', 'Гоголь'], correct: 1, timeLimit: 20 },
    { text: 'Байкал — самое глубокое озеро в мире?', answers: ['Да', 'Нет'], correct: 0, timeLimit: 10 },
    { text: 'Какой химический элемент обозначается буквой O?', answers: ['Золото', 'Кислород', 'Осмий', 'Олово'], correct: 1, timeLimit: 20 },
  ],
};

const params = new URLSearchParams(location.search);
let quizId = params.get('id');
let quiz = null;
let dirty = false;
let showErrors = false;
let leaving = false;

const titleInput = document.getElementById('quiz-title');
const questionsList = document.getElementById('questions');
const errorBox = document.getElementById('errors');
const summary = document.getElementById('summary');
const saveButton = document.getElementById('save');
const launchButton = document.getElementById('launch');
const addQuestionButton = document.getElementById('add-question');

// ---------- Модель ----------

const blankQuestion = () => ({ text: '', answers: ['', '', '', ''], correct: 0, timeLimit: LIMITS.defaultTimeLimit });
const blankQuiz = () => ({ title: '', questions: [blankQuestion()] });

function normalize(raw) {
  const questions = Array.isArray(raw?.questions) && raw.questions.length ? raw.questions : [blankQuestion()];
  return {
    title: typeof raw?.title === 'string' ? raw.title : '',
    questions: questions.slice(0, LIMITS.questionsMax).map((q) => {
      const answers = Array.isArray(q.answers) ? q.answers.slice(0, LIMITS.answersMax).map((a) => String(a ?? '')) : [];
      while (answers.length < LIMITS.answersMin) answers.push('');
      return {
        text: String(q.text ?? ''),
        answers,
        correct: Number.isInteger(q.correct) && q.correct < answers.length ? q.correct : 0,
        timeLimit: LIMITS.timeLimits.includes(q.timeLimit) ? q.timeLimit : LIMITS.defaultTimeLimit,
      };
    }),
  };
}

// Данные для сервера: обрезаем пробелы.
function serialize() {
  return {
    title: quiz.title.trim(),
    questions: quiz.questions.map((q) => ({
      text: q.text.trim(),
      answers: q.answers.map((a) => a.trim()),
      correct: q.correct,
      timeLimit: q.timeLimit,
    })),
  };
}

const length = (text) => [...text.trim()].length;

/** Возвращает список ошибок вида { field, message }, field — селектор поля для подсветки. */
function validate() {
  const errors = [];
  if (!quiz.title.trim()) errors.push({ field: '#quiz-title', message: 'Укажите название игры' });
  else if (length(quiz.title) > LIMITS.titleMax) errors.push({ field: '#quiz-title', message: `Название длиннее ${LIMITS.titleMax} символов` });

  if (quiz.questions.length === 0) errors.push({ field: null, message: 'Добавьте хотя бы один вопрос' });

  quiz.questions.forEach((q, qi) => {
    const label = `Вопрос ${qi + 1}`;
    if (!q.text.trim()) errors.push({ field: `[data-q="${qi}"][data-field="text"]`, message: `${label}: введите текст вопроса` });
    else if (length(q.text) > LIMITS.questionMax) errors.push({ field: `[data-q="${qi}"][data-field="text"]`, message: `${label}: текст длиннее ${LIMITS.questionMax} символов` });
    q.answers.forEach((answer, ai) => {
      if (!answer.trim()) errors.push({ field: `[data-q="${qi}"][data-a="${ai}"]`, message: `${label}: заполните вариант ${ai + 1}` });
      else if (length(answer) > LIMITS.answerMax) errors.push({ field: `[data-q="${qi}"][data-a="${ai}"]`, message: `${label}: вариант ${ai + 1} слишком длинный` });
    });
    if (!(q.correct >= 0 && q.correct < q.answers.length)) errors.push({ field: null, message: `${label}: отметьте правильный ответ` });
  });
  return errors;
}

// ---------- Отрисовка ----------

function timeSelect(q, qi) {
  return h('label', { class: 'time-select', title: 'Время на ответ' },
    h('span', { 'aria-hidden': 'true', text: '⏱' }),
    h('select', { class: 'select', dataset: { q: qi, field: 'time' }, 'aria-label': `Время на ответ, вопрос ${qi + 1}` },
      LIMITS.timeLimits.map((seconds) => h('option', { value: seconds, selected: seconds === q.timeLimit, text: `${seconds} сек` })),
    ),
  );
}

function answerRow(q, qi, answer, ai) {
  const isCorrect = q.correct === ai;
  return h('div', { class: `answer-edit answer-${ai}${isCorrect ? ' is-correct' : ''}` },
    h('span', { class: 'answer-badge', title: ANSWER_SHAPES[ai].name }, shapeIcon(ai)),
    h('input', {
      class: 'input answer-input',
      value: answer,
      maxlength: LIMITS.answerMax,
      placeholder: `Вариант ${ai + 1}${ai >= LIMITS.answersMin ? ' (необязательно)' : ''}`,
      dataset: { q: qi, a: ai, field: 'answer' },
      'aria-label': `Вопрос ${qi + 1}, вариант ${ai + 1}`,
      autocomplete: 'off',
    }),
    h('label', { class: 'correct-toggle', title: 'Правильный ответ' },
      h('input', { type: 'radio', name: `correct-${qi}`, checked: isCorrect, dataset: { q: qi, a: ai, field: 'correct' }, 'aria-label': `Вариант ${ai + 1} — правильный` }),
      h('span', { 'aria-hidden': 'true', text: '✓' }),
    ),
    q.answers.length > LIMITS.answersMin
      ? h('button', { class: 'icon-btn', type: 'button', title: 'Удалить вариант', 'aria-label': `Удалить вариант ${ai + 1}`, dataset: { action: 'remove-answer', q: qi, a: ai }, text: '✕' })
      : h('span', { class: 'icon-btn-spacer' }),
  );
}

function questionCard(q, qi) {
  const total = quiz.questions.length;
  const tool = (action, symbol, title, disabled = false) =>
    h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, disabled, dataset: { action, q: qi }, text: symbol });

  return h('li', { class: 'card question-card', dataset: { index: qi } },
    h('div', { class: 'question-head' },
      h('span', { class: 'question-number', text: `Вопрос ${qi + 1}` }),
      h('div', { class: 'question-tools' },
        timeSelect(q, qi),
        tool('up', '↑', 'Переместить выше', qi === 0),
        tool('down', '↓', 'Переместить ниже', qi === total - 1),
        tool('duplicate', '⧉', 'Дублировать вопрос', total >= LIMITS.questionsMax),
        tool('remove', '✕', 'Удалить вопрос', total === 1),
      ),
    ),
    h('textarea', {
      class: 'input question-text',
      rows: 2,
      maxlength: LIMITS.questionMax,
      placeholder: 'Текст вопроса',
      dataset: { q: qi, field: 'text' },
      'aria-label': `Текст вопроса ${qi + 1}`,
      value: q.text,
    }),
    h('div', { class: 'answers-edit' }, q.answers.map((answer, ai) => answerRow(q, qi, answer, ai))),
    q.answers.length < LIMITS.answersMax
      ? h('button', { class: 'btn btn-small btn-ghost add-answer', type: 'button', dataset: { action: 'add-answer', q: qi }, text: '+ Вариант ответа' })
      : null,
  );
}

function render() {
  titleInput.value = quiz.title;
  questionsList.replaceChildren(...quiz.questions.map(questionCard));
  addQuestionButton.disabled = quiz.questions.length >= LIMITS.questionsMax;
  updateSummary();
  if (showErrors) highlightErrors();
}

function updateSummary() {
  const count = quiz.questions.length;
  const seconds = quiz.questions.reduce((sum, q) => sum + q.timeLimit, 0);
  const minutes = Math.max(1, Math.round(seconds / 60));
  summary.textContent = `${count} ${plural(count, ['вопрос', 'вопроса', 'вопросов'])} · ~${minutes} мин на ответы${dirty ? ' · есть несохранённые изменения' : ''}`;
}

function highlightErrors() {
  const errors = validate();
  document.querySelectorAll('.is-invalid').forEach((node) => node.classList.remove('is-invalid'));
  for (const { field } of errors) {
    if (field) document.querySelector(field)?.classList.add('is-invalid');
  }
  if (errors.length === 0) {
    errorBox.hidden = true;
    return errors;
  }
  const shown = errors.slice(0, 6);
  errorBox.replaceChildren(h('div', {},
    h('strong', { text: 'Исправьте, пожалуйста:' }),
    h('ul', {}, shown.map((error) => h('li', { text: error.message }))),
    errors.length > shown.length ? h('p', { text: `…и ещё ${errors.length - shown.length}` }) : null,
  ));
  errorBox.hidden = false;
  return errors;
}

// ---------- Изменения ----------

function markDirty() {
  dirty = true;
  if (!quizId) editorDraft.set(quiz);
  updateSummary();
  if (showErrors) highlightErrors();
}

function changeStructure(mutator, focusSelector) {
  mutator();
  markDirty();
  render();
  if (focusSelector) {
    const node = document.querySelector(focusSelector);
    node?.focus();
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

titleInput.addEventListener('input', () => {
  quiz.title = titleInput.value;
  markDirty();
});

questionsList.addEventListener('input', (event) => {
  const { field, q, a } = event.target.dataset;
  const question = quiz.questions[Number(q)];
  if (!question) return;
  if (field === 'text') question.text = event.target.value;
  else if (field === 'answer') question.answers[Number(a)] = event.target.value;
  else return;
  markDirty();
});

questionsList.addEventListener('change', (event) => {
  const { field, q, a } = event.target.dataset;
  const question = quiz.questions[Number(q)];
  if (!question) return;
  if (field === 'time') {
    question.timeLimit = Number(event.target.value);
    markDirty();
  } else if (field === 'correct') {
    question.correct = Number(a);
    event.target.closest('.answers-edit').querySelectorAll('.answer-edit').forEach((row, index) => {
      row.classList.toggle('is-correct', index === question.correct);
    });
    markDirty();
  }
});

questionsList.addEventListener('click', (event) => {
  const button = event.target.closest('[data-action]');
  if (!button) return;
  const qi = Number(button.dataset.q);
  const question = quiz.questions[qi];
  if (!question) return;

  switch (button.dataset.action) {
    case 'up':
      if (qi > 0) changeStructure(() => quiz.questions.splice(qi - 1, 0, ...quiz.questions.splice(qi, 1)), `[data-q="${qi - 1}"][data-field="text"]`);
      break;
    case 'down':
      if (qi < quiz.questions.length - 1) changeStructure(() => quiz.questions.splice(qi + 1, 0, ...quiz.questions.splice(qi, 1)), `[data-q="${qi + 1}"][data-field="text"]`);
      break;
    case 'duplicate':
      if (quiz.questions.length < LIMITS.questionsMax) changeStructure(() => quiz.questions.splice(qi + 1, 0, structuredClone(question)), `[data-q="${qi + 1}"][data-field="text"]`);
      break;
    case 'remove':
      if (quiz.questions.length > 1) removeQuestion(qi);
      break;
    case 'add-answer':
      if (question.answers.length < LIMITS.answersMax) {
        changeStructure(() => question.answers.push(''), `[data-q="${qi}"][data-a="${question.answers.length}"]`);
      }
      break;
    case 'remove-answer': {
      const ai = Number(button.dataset.a);
      if (question.answers.length <= LIMITS.answersMin) break;
      changeStructure(() => {
        question.answers.splice(ai, 1);
        if (question.correct === ai) question.correct = 0;
        else if (question.correct > ai) question.correct -= 1;
      });
      break;
    }
    default:
  }
});

async function removeQuestion(qi) {
  const question = quiz.questions[qi];
  const isEmpty = !question.text.trim() && question.answers.every((a) => !a.trim());
  if (!isEmpty) {
    const confirmed = await confirmDialog({ title: `Удалить вопрос ${qi + 1}?`, message: question.text.trim(), confirmText: 'Удалить', danger: true });
    if (!confirmed) return;
  }
  changeStructure(() => quiz.questions.splice(qi, 1));
}

addQuestionButton.addEventListener('click', () => {
  if (quiz.questions.length >= LIMITS.questionsMax) return;
  const last = quiz.questions[quiz.questions.length - 1];
  const next = blankQuestion();
  if (last) next.timeLimit = last.timeLimit;
  changeStructure(() => quiz.questions.push(next), `[data-q="${quiz.questions.length}"][data-field="text"]`);
});

// ---------- Сохранение и запуск ----------

// Пустые необязательные варианты (3-й и 4-й) просто убираем, а не считаем ошибкой.
function pruneEmptyAnswers() {
  let changed = false;
  for (const question of quiz.questions) {
    for (let ai = question.answers.length - 1; ai >= 0 && question.answers.length > LIMITS.answersMin; ai -= 1) {
      if (question.answers[ai].trim() || ai === question.correct) continue;
      question.answers.splice(ai, 1);
      if (question.correct > ai) question.correct -= 1;
      changed = true;
    }
  }
  if (changed) {
    markDirty();
    render();
  }
}

function checkBeforeSubmit() {
  pruneEmptyAnswers();
  showErrors = true;
  const errors = highlightErrors();
  if (errors.length) {
    const first = errors.find((error) => error.field);
    const node = first ? document.querySelector(first.field) : errorBox;
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
    if (node && node !== errorBox) node.focus({ preventScroll: true });
    return false;
  }
  return true;
}

async function save() {
  if (!checkBeforeSubmit()) return;
  saveButton.disabled = true;
  try {
    if (quizId) {
      await api.updateQuiz(quizId, serialize());
    } else {
      const created = await api.createQuiz(serialize());
      quizId = created.id;
      history.replaceState(null, '', `editor.html?id=${encodeURIComponent(quizId)}`);
      editorDraft.clear();
      document.getElementById('draft-banner').hidden = true;
    }
    dirty = false;
    document.getElementById('editor-heading').textContent = 'Редактирование игры';
    updateSummary();
    toast('Игра сохранена', 'success');
  } catch (error) {
    toast(error.details?.[0] || error.message, 'error', 6000);
  } finally {
    saveButton.disabled = false;
  }
}

function launch() {
  if (!checkBeforeSubmit()) return;
  leaving = true;
  // Без изменений запускаем сохранённую версию, иначе — текущий черновик (его можно сохранить после игры).
  if (quizId && !dirty) launchGame({ quizId });
  else launchGame({ quizId, quiz: serialize() });
}

saveButton.addEventListener('click', save);
launchButton.addEventListener('click', launch);

document.addEventListener('keydown', (event) => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
    event.preventDefault();
    save();
  }
});

window.addEventListener('beforeunload', (event) => {
  // Новая игра автоматически сохраняется в черновик, для сохранённой — предупреждаем.
  if (dirty && quizId && !leaving) {
    event.preventDefault();
    event.returnValue = '';
  }
});

document.getElementById('discard-draft').addEventListener('click', () => {
  editorDraft.clear();
  quiz = blankQuiz();
  dirty = false;
  showErrors = false;
  errorBox.hidden = true;
  document.getElementById('draft-banner').hidden = true;
  render();
  titleInput.focus();
});

// ---------- Загрузка ----------

async function init() {
  if (quizId) {
    document.getElementById('editor-heading').textContent = 'Редактирование игры';
    questionsList.replaceChildren(h('li', { class: 'card question-card skeleton' }));
    try {
      quiz = normalize(await api.getQuiz(quizId));
      document.title = `Искра — ${quiz.title}`;
    } catch (error) {
      toast(error.message, 'error', 6000);
      quizId = null;
      history.replaceState(null, '', 'editor.html');
      quiz = blankQuiz();
      document.getElementById('editor-heading').textContent = 'Новая игра';
    }
  } else if (params.has('demo')) {
    quiz = normalize(structuredClone(DEMO_QUIZ));
    history.replaceState(null, '', 'editor.html');
    markDirty();
  } else {
    const draft = editorDraft.get();
    if (draft) {
      quiz = normalize(draft);
      dirty = true;
      document.getElementById('draft-banner').hidden = false;
    } else {
      quiz = blankQuiz();
    }
  }
  render();
  if (!quiz.title) titleInput.focus();
}

init();
