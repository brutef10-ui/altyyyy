// Общие элементы интерфейса ведущего: построение DOM, фигуры ответов, уведомления, диалоги.
// Пользовательские данные (ники, тексты) всегда вставляются как textContent — без innerHTML.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
    else if (key === 'style' && typeof value === 'object') {
      for (const [property, styleValue] of Object.entries(value)) {
        if (property.startsWith('--')) node.style.setProperty(property, styleValue);
        else node.style[property] = styleValue;
      }
    }
    else if (key.startsWith('on') && typeof value === 'function') node.addEventListener(key.slice(2).toLowerCase(), value);
    else if (key in node && typeof value !== 'string') node[key] = value;
    else node.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat(Infinity)) {
    if (child === null || child === undefined || child === false) continue;
    node.append(child instanceof Node ? child : document.createTextNode(String(child)));
  }
  return node;
}

// ---------- Фигуры вариантов ответа ----------

const SVG_NS = 'http://www.w3.org/2000/svg';

// Фигуры вариантов — театральные эмблемы: маска комедии, маска трагедии, арфа, полумаска.
// Рисуются цветом currentColor (viewBox 0 0 24 24); части без своего fill заливаются цветом.
const MASK_FACE = 'M3.6 4.6c0-1 .9-1.7 1.9-1.5 4.3.9 8.7.9 13 0 1-.2 1.9.5 1.9 1.5 0 7.6-3.4 16-8.4 16S3.6 12.2 3.6 4.6z';
const LINE = { fill: 'none', stroke: 'currentColor', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' };

export const ANSWER_SHAPES = [
  {
    name: 'Комедия',
    parts: [['path', {
      d: `${MASK_FACE}M6.3 9.9c.8-2.3 3.5-2.3 4.3 0-1.4-.8-2.9-.8-4.3 0zM13.4 9.9c.8-2.3 3.5-2.3 4.3 0-1.4-.8-2.9-.8-4.3 0zM7.4 12.9c3 .9 6.2.9 9.2 0-.4 3.2-2.3 4.9-4.6 4.9s-4.2-1.7-4.6-4.9z`,
      'fill-rule': 'evenodd',
      transform: 'rotate(-7 12 12)',
    }]],
  },
  {
    name: 'Трагедия',
    parts: [['path', {
      d: `${MASK_FACE}M6.3 8.6c1.4.9 2.9.9 4.3 0-.6 2.2-3.7 2.2-4.3 0zM13.4 8.6c1.4.9 2.9.9 4.3 0-.6 2.2-3.7 2.2-4.3 0zM7.9 17.6c.6-3 2.2-4.3 4.1-4.3s3.5 1.3 4.1 4.3c-1.3-1-2.6-1.4-4.1-1.4s-2.8.4-4.1 1.4z`,
      'fill-rule': 'evenodd',
      transform: 'rotate(7 12 12)',
    }]],
  },
  {
    name: 'Арфа',
    parts: [
      ['path', { d: 'M6.2 20.4V6.2C9 3.2 11.4 7.4 14.4 6.2c2-.8 2.8-2.6 5-2.4L8.2 20.4', ...LINE, 'stroke-width': 2.3 }],
      ['path', { d: 'M4.6 20.6h5.6', ...LINE, 'stroke-width': 2.1 }],
      ['path', { d: 'M8.9 5.4V17.6M11.4 6.4V14M13.9 6.4V10.4M16.4 5.4V6.9', ...LINE, 'stroke-width': 1.1 }],
    ],
  },
  {
    name: 'Маска',
    parts: [['path', {
      d: 'M1.3 6.8c3.3-.5 7.3.8 10.7 3 3.4-2.2 7.4-3.5 10.7-3 .5 5.3-1.8 10-6.1 10-2 0-3.5-1.2-4.6-2.6-1.1 1.4-2.6 2.6-4.6 2.6-4.3 0-6.6-4.7-6.1-10zM4.4 11.4c1.4-1.8 4.4-1.8 5.6.4-1.5 1.2-4.2 1.2-5.6-.4zM19.6 11.4c-1.4-1.8-4.4-1.8-5.6.4 1.5 1.2 4.2 1.2 5.6-.4z',
      'fill-rule': 'evenodd',
    }]],
  },
];

export function shapeIcon(index, className = 'shape') {
  const shape = ANSWER_SHAPES[index % ANSWER_SHAPES.length];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const [tag, attrs] of shape.parts) {
    const part = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attrs)) part.setAttribute(name, value);
    if (!('fill' in attrs)) part.setAttribute('fill', 'currentColor');
    svg.append(part);
  }
  return svg;
}

// ---------- Значки сцены (вместо эмодзи): линия текущего цвета ----------

const STAGE_ICONS = {
  play: ['M8 5.5v13l10.5-6.5z'],
  trash: ['M4 7h16', 'M10 11v6', 'M14 11v6', 'M6 7l1 12a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2l1-12', 'M9 7V4h6v3'],
  check: ['M5 12.6l4.6 4.6L19.2 7.4'],
  quill: ['M20 4c-6 1-11 6-13 13l-1.5 3.5', 'M20 4c-1 5-4.5 9-9.5 10.5', 'M7.5 14.5l3 3'],
  sound: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M15.5 9a4.2 4.2 0 0 1 0 6', 'M18 6.5a7.6 7.6 0 0 1 0 11'],
  mute: ['M4 9.5h3.5L12 5.5v13l-4.5-4H4z', 'M16 9.5l5 5', 'M21 9.5l-5 5'],
  hourglass: [
    { d: 'M4.8 2.6h14.4a1.05 1.05 0 0 1 0 2.1H4.8a1.05 1.05 0 0 1 0-2.1zM4.8 19.3h14.4a1.05 1.05 0 0 1 0 2.1H4.8a1.05 1.05 0 0 1 0-2.1z', fill: true },
    { d: 'M5.9 4.7v14.6M18.1 4.7v14.6', width: 1.4 },
    { d: 'M8.1 4.7c0 4.4 3.1 5.4 3.1 7.3s-3.1 2.9-3.1 7.3M15.9 4.7c0 4.4-3.1 5.4-3.1 7.3s3.1 2.9 3.1 7.3', width: 1.6 },
    { d: 'M8.8 19.3c.4-2.5 1.8-3.8 3.2-4.1 1.4.3 2.8 1.6 3.2 4.1z', fill: true },
    { d: 'M12 12.7v2.3', width: 1.1 },
  ],
};

export function stageIcon(name, className = 'stage-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const part of STAGE_ICONS[name] || []) {
    // Часть — строка (линия) или { d, fill, width } (заливка или линия своей толщины).
    const { d, fill = name === 'play', width = 2.2 } = typeof part === 'string' ? { d: part } : part;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', fill ? 'currentColor' : 'none');
    if (!fill || name === 'play') {
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', String(width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(path);
  }
  return svg;
}

// ---------- Аватар ----------

export function avatar(src, nickname, className = 'avatar') {
  if (src) return h('img', { class: className, src, alt: '', draggable: 'false', decoding: 'async' });
  return h('span', { class: `${className} avatar-placeholder`, text: (nickname || '?').slice(0, 1).toUpperCase(), 'aria-hidden': 'true' });
}

// ---------- Текст ----------

export function plural(count, [one, few, many]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}

export const formatCode = (code) => (code ? `${code.slice(0, 3)} ${code.slice(3)}` : '');
export const formatScore = (score) => Number(score || 0).toLocaleString('ru-RU');

export function formatDate(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString('ru-RU', { day: 'numeric', month: 'long', hour: '2-digit', minute: '2-digit' });
}

// ---------- Уведомления ----------

function toastHost() {
  let container = document.getElementById('toasts');
  if (!container) {
    container = h('div', { id: 'toasts', class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(container);
  }
  return container;
}

export function toast(message, type = 'info', timeoutMs = 3800) {
  const item = h('div', { class: `toast toast-${type}`, text: message });
  toastHost().append(item);
  setTimeout(() => {
    item.classList.add('is-leaving');
    item.addEventListener('animationend', () => item.remove(), { once: true });
  }, timeoutMs);
}

// ---------- Диалог подтверждения ----------

export function confirmDialog({ title, message = '', confirmText = 'Да', cancelText = 'Отмена', danger = false }) {
  return new Promise((resolve) => {
    const confirmButton = h('button', { class: `btn ${danger ? 'btn-danger' : 'btn-primary'}`, type: 'button', text: confirmText });
    const cancelButton = h('button', { class: 'btn btn-ghost', type: 'button', text: cancelText });
    const dialog = h('dialog', { class: 'modal' },
      h('h2', { class: 'modal-title', text: title }),
      message ? h('p', { class: 'muted', text: message }) : null,
      h('div', { class: 'modal-actions' }, cancelButton, confirmButton),
    );
    const finish = (result) => {
      dialog.close();
      dialog.remove();
      resolve(result);
    };
    confirmButton.addEventListener('click', () => finish(true));
    cancelButton.addEventListener('click', () => finish(false));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(false);
    });
    document.body.append(dialog);
    dialog.showModal();
    confirmButton.focus();
  });
}

// ---------- Полноэкранный оверлей (подключение, ошибки связи) ----------

let overlay = null;

export function showOverlay(text, { error = false, retry = false } = {}) {
  if (!overlay) {
    overlay = h('div', { class: 'overlay', role: 'alertdialog', 'aria-live': 'assertive' });
    document.body.append(overlay);
  }
  overlay.replaceChildren(
    h('div', { class: `overlay-box${error ? ' is-error' : ''}` },
      error ? h('div', { class: 'overlay-icon', text: '!' }) : h('div', { class: 'spinner', 'aria-hidden': 'true' }),
      h('p', { text }),
      retry ? h('button', { class: 'btn btn-primary', type: 'button', text: 'Обновить страницу', onclick: () => location.reload() }) : null,
      error ? h('a', { class: 'btn btn-ghost', href: 'index.html', text: 'На главную' }) : null,
    ),
  );
  overlay.hidden = false;
}

export function hideOverlay() {
  if (overlay) overlay.hidden = true;
}
