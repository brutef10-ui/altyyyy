// Редактор игры: название, вопросы двух типов (варианты ответа / ввод ответа), картинки,
// время на чтение и на ответ.
import { api, imageUrl } from './api.js';
import { requireAccount } from './auth.js';
import { editorDraft } from './session.js';
import { launchGame } from './socket.js';
import { ANSWER_SHAPES, confirmDialog, h, plural, shapeIcon, toast } from './ui.js';
import { EASE_OUT, prefersReducedMotion } from './theatre.js';

// Те же ограничения проверяет сервер (server/src/validate.js).
const LIMITS = {
  titleMax: 80,
  questionsMax: 50,
  questionMax: 200,
  answersMin: 2,
  answersMax: 4,
  answerMax: 80,
  acceptedMin: 1,
  acceptedMax: 5,
  timeLimits: [5, 10, 15, 20, 30, 45, 60, 90, 120],
  defaultTimeLimit: 20,
  readTimes: [0, 3, 5, 8, 10, 15],
  defaultReadTime: 5,
};

const QUESTION_TYPES = ['choice', 'text'];
const IMAGE_ID_PATTERN = /^[a-f0-9]{32}$/;

// Картинки: исходный файл до 20 МБ, на сервер уходит JPEG (или PNG/WebP с прозрачностью) до ~950 КБ.
const IMAGE = {
  sourceMaxBytes: 20 * 1024 * 1024,
  maxSide: 1280,
  targetBytes: 950 * 1024,
  quality: 0.82,
  minQuality: 0.5,
};

const TEXT_HINT = 'Игрок пишет ответ сам. Регистр, «ё», знаки препинания и небольшие опечатки не важны.';

const DEMO_QUIZ = {
  title: 'Разминка: обо всём понемногу',
  questions: [
    { type: 'choice', text: 'Какая планета — самая большая в Солнечной системе?', answers: ['Марс', 'Юпитер', 'Сатурн', 'Нептун'], correct: 1, timeLimit: 20, readTime: 5 },
    { type: 'text', text: 'Столица Франции?', accepted: ['Париж', 'Paris'], timeLimit: 20, readTime: 3 },
    { type: 'choice', text: 'Сколько континентов на Земле?', answers: ['5', '6', '7', '8'], correct: 2, timeLimit: 15, readTime: 3 },
    { type: 'choice', text: 'Кто написал роман в стихах «Евгений Онегин»?', answers: ['Лермонтов', 'Пушкин', 'Толстой', 'Гоголь'], correct: 1, timeLimit: 20, readTime: 5 },
    { type: 'text', text: 'Сколько ног у паука?', accepted: ['8', 'восемь'], timeLimit: 15, readTime: 3 },
    { type: 'choice', text: 'Байкал — самое глубокое озеро в мире?', answers: ['Да', 'Нет'], correct: 0, timeLimit: 10, readTime: 0 },
    { type: 'choice', text: 'Какой химический элемент обозначается буквой O?', answers: ['Золото', 'Кислород', 'Осмий', 'Олово'], correct: 1, timeLimit: 20, readTime: 8 },
  ],
};

const params = new URLSearchParams(location.search);
let quizId = params.get('id');
let quiz = null;
let dirty = false;
let showErrors = false;
let leaving = false;
let animateQuestion = null; // только что добавленный вопрос — его карточка появляется с анимацией

const titleInput = document.getElementById('quiz-title');
const questionsList = document.getElementById('questions');
const errorBox = document.getElementById('errors');
const summary = document.getElementById('summary');
const saveButton = document.getElementById('save');
const launchButton = document.getElementById('launch');
const addQuestionButton = document.getElementById('add-question');

// ---------- Иконки ----------

const SVG_NS = 'http://www.w3.org/2000/svg';
const ICONS = {
  choice: [
    ['rect', { x: 3, y: 3, width: 7.5, height: 7.5, rx: 2 }],
    ['rect', { x: 13.5, y: 3, width: 7.5, height: 7.5, rx: 2 }],
    ['rect', { x: 3, y: 13.5, width: 7.5, height: 7.5, rx: 2 }],
    ['rect', { x: 13.5, y: 13.5, width: 7.5, height: 7.5, rx: 2 }],
  ],
  text: [
    ['rect', { x: 2.5, y: 6, width: 19, height: 12, rx: 3 }],
    ['path', { d: 'M6.5 12h5M15.5 9v6' }],
  ],
  read: [
    ['path', { d: 'M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z' }],
    ['circle', { cx: 12, cy: 12, r: 3 }],
  ],
  timer: [
    ['circle', { cx: 12, cy: 13.5, r: 8 }],
    ['path', { d: 'M12 9.5v4l2.6 2.6M9.5 2.5h5' }],
  ],
  image: [
    ['rect', { x: 3, y: 4, width: 18, height: 16, rx: 3 }],
    ['circle', { cx: 9, cy: 10, r: 2 }],
    ['path', { d: 'm21 15.5-4.6-4.6a1.5 1.5 0 0 0-2.1 0L5.5 20' }],
  ],
  check: [['path', { d: 'm5 12.5 4.5 4.5L19 7.5' }]],
  info: [
    ['circle', { cx: 12, cy: 12, r: 9.5 }],
    ['path', { d: 'M12 11v5.5M12 7.6v.1' }],
  ],
  replace: [['path', { d: 'M20 11a8 8 0 0 0-14.3-4.9L4 8M4 4v4h4M4 13a8 8 0 0 0 14.3 4.9L20 16M20 20v-4h-4' }]],
  trash: [['path', { d: 'M4 7h16M10 11v6M14 11v6M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12M9 7V4h6v3' }]],
};

function icon(name, className = 'ui-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const [tag, attrs] of ICONS[name]) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [attr, value] of Object.entries(attrs)) node.setAttribute(attr, value);
    svg.append(node);
  }
  return svg;
}

// ---------- Модель ----------
// В памяти у вопроса хранятся данные обоих типов (answers/correct и accepted): при переключении
// типа ничего не теряется. На сервер уходят только поля текущего типа (см. serialize).

const blankQuestion = () => ({
  type: 'choice',
  text: '',
  image: null,
  timeLimit: LIMITS.defaultTimeLimit,
  readTime: LIMITS.defaultReadTime,
  answers: ['', '', '', ''],
  correct: 0,
  accepted: [''],
});
const blankQuiz = () => ({ title: '', questions: [blankQuestion()] });

const toStrings = (list, max) => (Array.isArray(list) ? list.slice(0, max).map((item) => String(item ?? '')) : []);

function normalizeQuestion(raw) {
  const q = raw && typeof raw === 'object' ? raw : {};
  // Старые игры (без type/readTime/image) — это вопросы с вариантами, 5 секунд на чтение, без картинки.
  const type = QUESTION_TYPES.includes(q.type) ? q.type : 'choice';
  let answers = toStrings(q.answers, LIMITS.answersMax);
  if (answers.length === 0) answers = ['', '', '', ''];
  while (answers.length < LIMITS.answersMin) answers.push('');
  const accepted = toStrings(q.accepted, LIMITS.acceptedMax);
  if (accepted.length === 0) accepted.push('');
  return {
    type,
    text: String(q.text ?? ''),
    image: typeof q.image === 'string' && IMAGE_ID_PATTERN.test(q.image) ? q.image : null,
    timeLimit: LIMITS.timeLimits.includes(q.timeLimit) ? q.timeLimit : LIMITS.defaultTimeLimit,
    readTime: LIMITS.readTimes.includes(q.readTime) ? q.readTime : LIMITS.defaultReadTime,
    answers,
    correct: Number.isInteger(q.correct) && q.correct >= 0 && q.correct < answers.length ? q.correct : 0,
    accepted,
  };
}

function normalize(raw) {
  const questions = Array.isArray(raw?.questions) && raw.questions.length ? raw.questions : [blankQuestion()];
  return {
    title: typeof raw?.title === 'string' ? raw.title : '',
    questions: questions.slice(0, LIMITS.questionsMax).map(normalizeQuestion),
  };
}

// Данные для сервера: обрезаем пробелы, отправляем только поля выбранного типа.
function serialize() {
  return {
    title: quiz.title.trim(),
    questions: quiz.questions.map((q) => {
      const base = { type: q.type, text: q.text.trim(), image: q.image || null, timeLimit: q.timeLimit, readTime: q.readTime };
      if (q.type === 'text') return { ...base, accepted: q.accepted.map((a) => a.trim()) };
      return { ...base, answers: q.answers.map((a) => a.trim()), correct: q.correct };
    }),
  };
}

const length = (text) => [...text.trim()].length;
const fieldOf = (qi, extra) => `[data-q="${qi}"]${extra}`;

/** Возвращает список ошибок вида { field, message }, field — селектор поля для подсветки. */
function validate() {
  const errors = [];
  if (!quiz.title.trim()) errors.push({ field: '#quiz-title', message: 'Укажите название игры' });
  else if (length(quiz.title) > LIMITS.titleMax) errors.push({ field: '#quiz-title', message: `Название длиннее ${LIMITS.titleMax} символов` });

  if (quiz.questions.length === 0) errors.push({ field: null, message: 'Добавьте хотя бы один вопрос' });

  quiz.questions.forEach((q, qi) => {
    const label = `Вопрос ${qi + 1}`;
    const textField = fieldOf(qi, '[data-field="text"]');
    if (!q.text.trim()) errors.push({ field: textField, message: `${label}: введите текст вопроса` });
    else if (length(q.text) > LIMITS.questionMax) errors.push({ field: textField, message: `${label}: текст длиннее ${LIMITS.questionMax} символов` });

    if (q.type === 'text') {
      if (q.accepted.length < LIMITS.acceptedMin || q.accepted.length > LIMITS.acceptedMax) {
        errors.push({ field: null, message: `${label}: нужно от ${LIMITS.acceptedMin} до ${LIMITS.acceptedMax} правильных ответов` });
      }
      q.accepted.forEach((answer, i) => {
        const field = fieldOf(qi, `[data-acc="${i}"]`);
        const name = q.accepted.length > 1 ? `правильный ответ ${i + 1}` : 'правильный ответ';
        if (!answer.trim()) errors.push({ field, message: `${label}: впишите ${name}` });
        else if (length(answer) > LIMITS.answerMax) errors.push({ field, message: `${label}: ${name} длиннее ${LIMITS.answerMax} символов` });
      });
      return;
    }

    if (q.answers.length < LIMITS.answersMin || q.answers.length > LIMITS.answersMax) {
      errors.push({ field: null, message: `${label}: нужно от ${LIMITS.answersMin} до ${LIMITS.answersMax} вариантов ответа` });
    }
    q.answers.forEach((answer, ai) => {
      const field = fieldOf(qi, `[data-a="${ai}"]`);
      if (!answer.trim()) errors.push({ field, message: `${label}: заполните вариант ${ai + 1}` });
      else if (length(answer) > LIMITS.answerMax) errors.push({ field, message: `${label}: вариант ${ai + 1} слишком длинный` });
    });
    if (!(q.correct >= 0 && q.correct < q.answers.length)) errors.push({ field: null, message: `${label}: отметьте правильный ответ` });
  });
  return errors;
}

// ---------- Отрисовка ----------

const formatReadTime = (seconds) => (seconds === 0 ? 'без паузы' : `${seconds} сек`);
const readTimeTitle = (q) =>
  `Сколько секунд игроки видят только вопрос, прежде чем ${q.type === 'text' ? 'появится поле для ответа' : 'появятся варианты'}`;

function timingSelect({ qi, field, iconName, label, ariaLabel, title, values, current, format }) {
  return h('label', { class: 'timing', title },
    icon(iconName),
    h('span', { class: 'timing-label', text: label }),
    h('select', { class: 'select timing-select', dataset: { q: qi, field }, 'aria-label': `${ariaLabel}, вопрос ${qi + 1}` },
      values.map((seconds) => h('option', { value: seconds, selected: seconds === current, text: format(seconds) })),
    ),
  );
}

function typeSwitch(q, qi) {
  const option = (type, text, iconName) =>
    h('label', { class: 'segment' },
      h('input', { type: 'radio', name: `type-${qi}`, value: type, checked: q.type === type, dataset: { q: qi, field: 'type' } }),
      h('span', { class: 'segment-face' }, icon(iconName), h('span', { text })),
    );
  return h('div', { class: 'segmented', role: 'radiogroup', 'aria-label': `Тип вопроса ${qi + 1}` },
    option('choice', 'Варианты ответа', 'choice'),
    option('text', 'Ввод ответа', 'text'),
  );
}

// ---------- Картинка вопроса ----------

const uploads = new WeakMap(); // вопрос → { previewUrl } пока картинка загружается
const localPreviews = new Map(); // id картинки → object URL уже загруженного файла (без повторного скачивания)
const freshImages = new Set(); // только что загруженные — их превью появляется с анимацией

function imageSlot(q, qi) {
  const upload = uploads.get(q);
  if (upload) {
    return h('div', { class: 'image-slot image-preview is-uploading', 'aria-busy': 'true' },
      upload.previewUrl ? h('img', { class: 'image-main', src: upload.previewUrl, alt: '', draggable: 'false' }) : null,
      h('div', { class: 'image-progress', role: 'status' },
        h('span', { class: 'spinner', 'aria-hidden': 'true' }),
        h('span', { text: upload.previewUrl ? 'Загружаем…' : 'Готовим картинку…' }),
      ),
    );
  }

  if (!q.image) {
    return h('button', {
      class: 'image-slot image-add',
      type: 'button',
      dataset: { action: 'pick-image', q: qi },
      'aria-label': `Добавить картинку к вопросу ${qi + 1}`,
    },
      icon('image', 'ui-icon image-add-icon'),
      h('span', { class: 'image-add-text' },
        h('span', { class: 'image-add-title', text: 'Добавить картинку' }),
        h('small', { class: 'image-add-hint', text: 'или перетащите файл сюда' }),
      ),
    );
  }

  const src = localPreviews.get(q.image) || imageUrl(q.image);
  const fresh = freshImages.delete(q.image);
  const markBroken = (event) => event.target.closest('.image-slot')?.classList.add('is-broken');
  return h('figure', { class: `image-slot image-preview${fresh ? ' is-fresh' : ''}` },
    h('img', { class: 'image-backdrop', src, alt: '', 'aria-hidden': 'true', draggable: 'false', decoding: 'async' }),
    h('img', { class: 'image-main', src, alt: `Картинка к вопросу ${qi + 1}`, draggable: 'false', decoding: 'async', onerror: markBroken }),
    h('p', { class: 'image-broken', text: 'Картинка не загрузилась — замените её' }),
    h('div', { class: 'image-actions' },
      h('button', { class: 'btn btn-small image-action', type: 'button', dataset: { action: 'pick-image', q: qi }, 'aria-label': `Заменить картинку вопроса ${qi + 1}` },
        icon('replace'), h('span', { text: 'Заменить' })),
      h('button', { class: 'btn btn-small image-action', type: 'button', dataset: { action: 'remove-image', q: qi }, 'aria-label': `Убрать картинку из вопроса ${qi + 1}` },
        icon('trash'), h('span', { text: 'Убрать' })),
    ),
  );
}

// ---------- Варианты ответа ----------

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

function choiceEditor(q, qi) {
  return h('div', { class: 'answers-edit' }, q.answers.map((answer, ai) => answerRow(q, qi, answer, ai)));
}

// ---------- Ввод ответа ----------

function acceptedRow(q, qi, answer, i) {
  return h('div', { class: 'answer-edit is-accepted' },
    h('span', { class: 'answer-badge', title: 'Засчитывается как правильный' }, icon('check', 'ui-icon accepted-icon')),
    h('input', {
      class: 'input answer-input',
      value: answer,
      maxlength: LIMITS.answerMax,
      placeholder: i === 0 ? 'Правильный ответ' : 'Другое написание (необязательно)',
      dataset: { q: qi, acc: i, field: 'accepted' },
      'aria-label': `Вопрос ${qi + 1}, правильный ответ ${i + 1}`,
      autocomplete: 'off',
      spellcheck: 'false',
    }),
    q.accepted.length > LIMITS.acceptedMin
      ? h('button', { class: 'icon-btn', type: 'button', title: 'Удалить ответ', 'aria-label': `Удалить правильный ответ ${i + 1}`, dataset: { action: 'remove-accepted', q: qi, acc: i }, text: '✕' })
      : h('span', { class: 'icon-btn-spacer' }),
  );
}

function textEditor(q, qi) {
  return h('div', { class: 'accepted-editor' },
    h('p', { class: 'accepted-hint' }, icon('info'), h('span', { text: TEXT_HINT })),
    h('div', { class: 'answers-edit' }, q.accepted.map((answer, i) => acceptedRow(q, qi, answer, i))),
  );
}

// ---------- Карточка вопроса ----------

function questionCard(q, qi) {
  const total = quiz.questions.length;
  const tool = (action, symbol, title, disabled = false) =>
    h('button', { class: 'icon-btn', type: 'button', title, 'aria-label': title, disabled, dataset: { action, q: qi }, text: symbol });

  const isText = q.type === 'text';
  const canAdd = isText ? q.accepted.length < LIMITS.acceptedMax : q.answers.length < LIMITS.answersMax;
  const addButton = canAdd
    ? h('button', {
      class: 'btn btn-small btn-ghost add-answer',
      type: 'button',
      dataset: { action: isText ? 'add-accepted' : 'add-answer', q: qi },
      text: isText ? '+ Ещё правильный ответ' : '+ Вариант ответа',
    })
    : null;

  return h('li', { class: `card question-card is-${q.type}${q === animateQuestion ? ' is-new' : ''}`, dataset: { index: qi } },
    h('div', { class: 'question-head' },
      h('span', { class: 'question-number', text: `Вопрос ${qi + 1}` }),
      typeSwitch(q, qi),
      h('div', { class: 'question-tools' },
        tool('up', '↑', 'Переместить выше', qi === 0),
        tool('down', '↓', 'Переместить ниже', qi === total - 1),
        tool('duplicate', '⧉', 'Дублировать вопрос', total >= LIMITS.questionsMax),
        tool('remove', '✕', 'Удалить вопрос', total === 1),
      ),
    ),
    h('div', { class: 'question-body' },
      h('textarea', {
        class: 'input question-text',
        rows: 3,
        maxlength: LIMITS.questionMax,
        placeholder: 'Текст вопроса',
        dataset: { q: qi, field: 'text' },
        'aria-label': `Текст вопроса ${qi + 1}`,
        value: q.text,
      }),
      imageSlot(q, qi),
    ),
    h('div', { class: 'question-answers' }, isText ? textEditor(q, qi) : choiceEditor(q, qi)),
    h('div', { class: 'question-foot' },
      addButton,
      h('div', { class: 'question-timing' },
        timingSelect({
          qi,
          field: 'read',
          iconName: 'read',
          label: 'Чтение',
          ariaLabel: 'Время на чтение вопроса',
          title: readTimeTitle(q),
          values: LIMITS.readTimes,
          current: q.readTime,
          format: formatReadTime,
        }),
        timingSelect({
          qi,
          field: 'time',
          iconName: 'timer',
          label: 'Ответ',
          ariaLabel: 'Время на ответ',
          title: 'Сколько секунд даётся на ответ',
          values: LIMITS.timeLimits,
          current: q.timeLimit,
          format: (seconds) => `${seconds} сек`,
        }),
      ),
    ),
  );
}

function render() {
  titleInput.value = quiz.title;
  questionsList.replaceChildren(...quiz.questions.map(questionCard));
  animateQuestion = null;
  addQuestionButton.disabled = quiz.questions.length >= LIMITS.questionsMax;
  updateSummary();
  if (showErrors) highlightErrors();
}

/** Перерисовывает одну карточку (без анимации появления) — фокус в остальных полях не сбивается. */
function renderCard(qi, focusSelector) {
  const current = questionsList.children[qi];
  if (!current) {
    render();
    return;
  }
  const card = questionCard(quiz.questions[qi], qi);
  current.replaceWith(card);
  if (showErrors) highlightErrors();
  if (focusSelector) card.querySelector(focusSelector)?.focus();
}

function updateSummary() {
  const count = quiz.questions.length;
  const seconds = quiz.questions.reduce((sum, q) => sum + q.timeLimit + q.readTime, 0);
  const minutes = Math.max(1, Math.round(seconds / 60));
  summary.textContent = `${count} ${plural(count, ['вопрос', 'вопроса', 'вопросов'])} · ~${minutes} мин на чтение и ответы${dirty ? ' · есть несохранённые изменения' : ''}`;
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

// Карточки, которые остались на сцене, переезжают на новые места плавно (FLIP),
// новая карточка опускается сверху (класс is-new), удалённая перед этим уходит в люк.
function changeStructure(mutator, focusSelector) {
  const before = new Map(); // вопрос → где стояла его карточка
  [...questionsList.children].forEach((card, i) => {
    if (quiz.questions[i]) before.set(quiz.questions[i], card.getBoundingClientRect().top);
  });
  mutator();
  markDirty();
  render();
  if (!prefersReducedMotion()) {
    [...questionsList.children].forEach((card, i) => {
      const top = before.get(quiz.questions[i]);
      if (top === undefined) return;
      const shift = top - card.getBoundingClientRect().top;
      if (Math.abs(shift) < 2) return;
      card.animate(
        [{ transform: `translateY(${shift}px)` }, { transform: 'none' }],
        { duration: 560, easing: EASE_OUT },
      );
    });
  }
  if (focusSelector) {
    const node = document.querySelector(focusSelector);
    node?.focus();
    node?.scrollIntoView({ behavior: 'smooth', block: 'center' });
  }
}

/** Меняет тип вопроса. Данные другого типа остаются в памяти; пустой новый тип заполняем из старого. */
function switchType(question, qi, type) {
  if (!QUESTION_TYPES.includes(type) || question.type === type) return;
  if (type === 'text' && question.accepted.every((a) => !a.trim())) {
    const correctAnswer = question.answers[question.correct]?.trim();
    if (correctAnswer) question.accepted = [correctAnswer];
  } else if (type === 'choice' && question.answers.every((a) => !a.trim())) {
    const firstAccepted = question.accepted.find((a) => a.trim())?.trim();
    if (firstAccepted) {
      question.answers[0] = firstAccepted;
      question.correct = 0;
    }
  }
  question.type = type;
  markDirty();
  renderCard(qi, `[data-field="type"][value="${type}"]`);
  questionsList.children[qi]?.querySelector('.question-answers')?.classList.add('is-switched');
}

titleInput.addEventListener('input', () => {
  quiz.title = titleInput.value;
  markDirty();
});

questionsList.addEventListener('input', (event) => {
  const { field, q, a, acc } = event.target.dataset;
  const question = quiz.questions[Number(q)];
  if (!question) return;
  if (field === 'text') question.text = event.target.value;
  else if (field === 'answer') question.answers[Number(a)] = event.target.value;
  else if (field === 'accepted') question.accepted[Number(acc)] = event.target.value;
  else return;
  markDirty();
});

questionsList.addEventListener('change', (event) => {
  const { field, q, a } = event.target.dataset;
  const qi = Number(q);
  const question = quiz.questions[qi];
  if (!question) return;
  if (field === 'time') {
    question.timeLimit = Number(event.target.value);
    markDirty();
  } else if (field === 'read') {
    question.readTime = Number(event.target.value);
    markDirty();
  } else if (field === 'type') {
    switchType(question, qi, event.target.value);
  } else if (field === 'correct') {
    question.correct = Number(a);
    event.target.closest('.answers-edit').querySelectorAll('.answer-edit').forEach((row, index) => {
      row.classList.toggle('is-correct', index === question.correct);
    });
    markDirty();
  }
});

/** Новая строка варианта выезжает с анимацией. */
function markNewRow(qi, selector) {
  questionsList.children[qi]?.querySelector(`.answers-edit ${selector}`)?.classList.add('is-new');
}

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
      if (quiz.questions.length < LIMITS.questionsMax) {
        const copy = structuredClone(question);
        animateQuestion = copy;
        changeStructure(() => quiz.questions.splice(qi + 1, 0, copy), `[data-q="${qi + 1}"][data-field="text"]`);
      }
      break;
    case 'remove':
      if (quiz.questions.length > 1) removeQuestion(qi);
      break;
    case 'add-answer':
      if (question.answers.length < LIMITS.answersMax) {
        question.answers.push('');
        markDirty();
        renderCard(qi, `[data-a="${question.answers.length - 1}"]`);
        markNewRow(qi, '.answer-edit:last-child');
      }
      break;
    case 'remove-answer': {
      const ai = Number(button.dataset.a);
      if (question.answers.length <= LIMITS.answersMin) break;
      question.answers.splice(ai, 1);
      if (question.correct === ai) question.correct = 0;
      else if (question.correct > ai) question.correct -= 1;
      markDirty();
      renderCard(qi, `[data-a="${Math.min(ai, question.answers.length - 1)}"][data-field="answer"]`);
      break;
    }
    case 'add-accepted':
      if (question.accepted.length < LIMITS.acceptedMax) {
        question.accepted.push('');
        markDirty();
        renderCard(qi, `[data-acc="${question.accepted.length - 1}"]`);
        markNewRow(qi, '.answer-edit:last-child');
      }
      break;
    case 'remove-accepted': {
      const i = Number(button.dataset.acc);
      if (question.accepted.length <= LIMITS.acceptedMin) break;
      question.accepted.splice(i, 1);
      markDirty();
      renderCard(qi, `[data-acc="${Math.min(i, question.accepted.length - 1)}"][data-field="accepted"]`);
      break;
    }
    case 'pick-image':
      pickImage(question);
      break;
    case 'remove-image':
      question.image = null;
      markDirty();
      renderCard(qi, '[data-action="pick-image"]');
      break;
    default:
  }
});

/** Элемент уходит со сцены в люк; промис выполняется, когда он скрылся. */
function sinkAway(node) {
  if (!node?.animate || prefersReducedMotion()) return Promise.resolve();
  return node.animate(
    [
      { opacity: 1, transform: 'none' },
      { opacity: 0, transform: 'perspective(900px) translateY(36px) rotateX(-55deg) scale(0.92)' },
    ],
    { duration: 380, easing: 'cubic-bezier(.55, 0, .75, .2)', fill: 'forwards' },
  ).finished.catch(() => {});
}

let removing = false; // карточка уходит — повторное нажатие не удаляет следующий вопрос

async function removeQuestion(qi) {
  if (removing) return;
  const question = quiz.questions[qi];
  const isEmpty = !question.text.trim() && !question.image
    && question.answers.every((a) => !a.trim()) && question.accepted.every((a) => !a.trim());
  if (!isEmpty) {
    const confirmed = await confirmDialog({ title: `Удалить вопрос ${qi + 1}?`, message: question.text.trim(), confirmText: 'Удалить', danger: true });
    if (!confirmed) return;
  }
  removing = true;
  await sinkAway(questionsList.children[quiz.questions.indexOf(question)]);
  removing = false;
  const index = quiz.questions.indexOf(question);
  if (index >= 0 && quiz.questions.length > 1) changeStructure(() => quiz.questions.splice(index, 1));
}

addQuestionButton.addEventListener('click', () => {
  if (quiz.questions.length >= LIMITS.questionsMax) return;
  const last = quiz.questions[quiz.questions.length - 1];
  const next = blankQuestion();
  if (last) {
    next.timeLimit = last.timeLimit;
    next.readTime = last.readTime;
  }
  animateQuestion = next;
  changeStructure(() => quiz.questions.push(next), `[data-q="${quiz.questions.length}"][data-field="text"]`);
});

// ---------- Загрузка картинок ----------

const filePicker = h('input', { type: 'file', accept: 'image/*', hidden: true, tabindex: '-1', 'aria-hidden': 'true' });
document.body.append(filePicker);
let pickTarget = null; // вопрос (объект, а не номер — порядок может измениться, пока открыт выбор файла)

function pickImage(question) {
  if (uploads.has(question)) return;
  pickTarget = question;
  filePicker.value = '';
  filePicker.click();
}

filePicker.addEventListener('change', () => {
  const file = filePicker.files?.[0];
  const question = pickTarget;
  pickTarget = null;
  filePicker.value = '';
  if (file && question) attachImage(question, file);
});

class ImageError extends Error {}

function decodeFailed() {
  return new ImageError('Не удалось открыть картинку. Выберите файл JPG, PNG или WebP.');
}

/** Декодирует файл с учётом поворота из EXIF (фото с телефона не окажутся «на боку»). */
async function decodeImage(file) {
  if (typeof createImageBitmap === 'function') {
    try {
      const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
      return { source: bitmap, width: bitmap.width, height: bitmap.height, release: () => bitmap.close?.() };
    } catch {
      // Старый браузер или формат, который createImageBitmap не умеет, — пробуем через <img>.
    }
  }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  try {
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = reject;
      img.src = url;
    });
  } catch {
    URL.revokeObjectURL(url);
    throw decodeFailed();
  }
  return { source: img, width: img.naturalWidth, height: img.naturalHeight, release: () => URL.revokeObjectURL(url) };
}

const canvasToBlob = (canvas, type, quality) => new Promise((resolve) => canvas.toBlob(resolve, type, quality));

function hasTransparency(context, width, height) {
  const { data } = context.getImageData(0, 0, width, height);
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] < 250) return true;
  }
  return false;
}

/**
 * Уменьшает картинку (длинная сторона ≤ 1280 px) и сжимает до ~950 КБ.
 * Перекодирование заодно убирает из фото метаданные (в том числе геолокацию).
 */
async function prepareImage(file) {
  const image = await decodeImage(file);
  try {
    if (!image.width || !image.height) throw decodeFailed();
    const mayBeTransparent = /png|webp|gif|svg/i.test(file.type || '');
    let scale = Math.min(1, IMAGE.maxSide / Math.max(image.width, image.height));

    for (let attempt = 0; attempt < 4; attempt += 1) {
      const width = Math.max(1, Math.round(image.width * scale));
      const height = Math.max(1, Math.round(image.height * scale));
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      const context = canvas.getContext('2d', { willReadFrequently: mayBeTransparent });
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(image.source, 0, 0, width, height);

      // Логотипы и стикеры с прозрачным фоном сохраняем без белой подложки, если влезают по размеру.
      if (mayBeTransparent && hasTransparency(context, width, height)) {
        const png = await canvasToBlob(canvas, 'image/png');
        if (png && png.size <= IMAGE.targetBytes) return png;
        const webp = await canvasToBlob(canvas, 'image/webp', 0.86);
        if (webp && webp.type === 'image/webp' && webp.size <= IMAGE.targetBytes) return webp;
        context.globalCompositeOperation = 'destination-over';
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);
        context.globalCompositeOperation = 'source-over';
      }

      for (let quality = IMAGE.quality; quality >= IMAGE.minQuality - 0.001; quality -= 0.08) {
        const blob = await canvasToBlob(canvas, 'image/jpeg', quality);
        if (!blob) throw decodeFailed();
        if (blob.size <= IMAGE.targetBytes) return blob;
      }
      scale *= 0.75;
    }
    throw new ImageError('Картинку не получилось сжать до 1 МБ. Выберите другую.');
  } finally {
    image.release();
  }
}

function updateImageSlot(question, { restoreFocus = false } = {}) {
  const qi = quiz.questions.indexOf(question);
  if (qi < 0) return;
  const slot = questionsList.children[qi]?.querySelector('.image-slot');
  if (!slot) return;
  const hadFocus = slot.contains(document.activeElement);
  const next = imageSlot(question, qi);
  slot.replaceWith(next);
  const focusLost = !document.activeElement || document.activeElement === document.body;
  if (hadFocus || (restoreFocus && focusLost)) {
    (next.matches('button') ? next : next.querySelector('button'))?.focus({ preventScroll: true });
  }
}

async function attachImage(question, file) {
  if (uploads.has(question)) return;
  if (file.type && !file.type.startsWith('image/')) {
    toast('Это не картинка. Выберите файл JPG, PNG или WebP.', 'error', 5000);
    return;
  }
  if (file.size > IMAGE.sourceMaxBytes) {
    toast('Файл больше 20 МБ — выберите картинку поменьше.', 'error', 5000);
    return;
  }
  if (file.size === 0) {
    toast('Файл пустой — выберите другую картинку.', 'error', 5000);
    return;
  }

  const state = { previewUrl: null };
  uploads.set(question, state);
  updateImageSlot(question);
  let uploaded = false;
  try {
    // Любая ошибка обработки (неизвестный формат, «испорченный» холст) — понятное сообщение вместо технического.
    const blob = await prepareImage(file).catch((error) => {
      throw error instanceof ImageError ? error : decodeFailed();
    });
    state.previewUrl = URL.createObjectURL(blob);
    updateImageSlot(question);
    const { id } = await api.uploadImage(blob);
    if (typeof id !== 'string' || !IMAGE_ID_PATTERN.test(id)) throw new Error('Сервер вернул неожиданный ответ. Попробуйте ещё раз.');
    localPreviews.set(id, state.previewUrl);
    freshImages.add(id);
    uploaded = true;
    // Вопрос могли удалить, пока шла загрузка, — тогда картинка просто не нужна.
    if (quiz.questions.includes(question)) {
      question.image = id;
      markDirty();
    }
  } catch (error) {
    const message = error instanceof ImageError || error?.status ? error.message : `Не удалось загрузить картинку. ${error?.message || ''}`.trim();
    toast(message, 'error', 6000);
  } finally {
    if (!uploaded && state.previewUrl) URL.revokeObjectURL(state.previewUrl);
    uploads.delete(question);
    updateImageSlot(question, { restoreFocus: true });
  }
}

// Перетаскивание файла на место для картинки (на компьютере).
const hasFiles = (event) => Array.from(event.dataTransfer?.types || []).includes('Files');
const dropSlot = (event) => event.target.closest?.('.image-slot:not(.is-uploading)');

questionsList.addEventListener('dragover', (event) => {
  const slot = dropSlot(event);
  if (!slot || !hasFiles(event)) return;
  event.preventDefault();
  event.dataTransfer.dropEffect = 'copy';
  slot.classList.add('is-dragover');
});

questionsList.addEventListener('dragleave', (event) => {
  const slot = dropSlot(event);
  if (slot && !slot.contains(event.relatedTarget)) slot.classList.remove('is-dragover');
});

questionsList.addEventListener('drop', (event) => {
  const slot = dropSlot(event);
  if (!slot || !hasFiles(event)) return;
  event.preventDefault();
  slot.classList.remove('is-dragover');
  const qi = Array.prototype.indexOf.call(questionsList.children, slot.closest('.question-card'));
  const question = quiz.questions[qi];
  const file = event.dataTransfer.files?.[0];
  if (question && file) attachImage(question, file);
});

// Файл, брошенный мимо, не должен открываться в браузере вместо редактора.
for (const type of ['dragover', 'drop']) {
  window.addEventListener(type, (event) => {
    if (hasFiles(event) && !dropSlot(event)) {
      event.preventDefault();
      if (event.dataTransfer) event.dataTransfer.dropEffect = 'none';
    }
  });
}

// ---------- Сохранение и запуск ----------

// Пустые необязательные варианты (3-й и 4-й) и лишние пустые правильные ответы просто убираем, а не считаем ошибкой.
function pruneEmptyAnswers() {
  let changed = false;
  for (const question of quiz.questions) {
    if (question.type === 'text') {
      const filled = question.accepted.filter((a) => a.trim());
      const next = filled.length ? filled : [question.accepted[0] ?? ''];
      if (next.length !== question.accepted.length) {
        question.accepted = next;
        changed = true;
      }
      continue;
    }
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
  const uploading = quiz.questions.findIndex((q) => uploads.has(q));
  if (uploading >= 0) {
    toast(`Подождите, загружается картинка к вопросу ${uploading + 1}`, 'info');
    return false;
  }
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
    // Картинка удалена с сервера (например, черновик пролежал больше 48 часов) — покажем, какая именно.
    if (error.code === 'IMAGE_MISSING') document.querySelector('.image-slot.is-broken')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
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
      document.title = `Luminous — ${quiz.title}`;
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
  // Первая отрисовка — с анимацией появления карточек, дальше карточки не «прыгают» при каждом изменении.
  // Начальное появление страниц сценария идёт вместе с открытием занавеса (до ~1,4 с).
  requestAnimationFrame(() => setTimeout(() => questionsList.classList.add('is-ready'), 1500));
  if (!quiz.title) titleInput.focus();
}

// Создавать игры (и открывать демо) можно только после входа. Сервер всё равно проверит это сам.
requireAccount();
init();
