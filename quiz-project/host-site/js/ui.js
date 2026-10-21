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

export const ANSWER_SHAPES = [
  { name: 'Треугольник', tag: 'path', attrs: { d: 'M12 2.8 22.2 20.6H1.8z' } },
  { name: 'Круг', tag: 'circle', attrs: { cx: 12, cy: 12, r: 9.6 } },
  { name: 'Звезда', tag: 'path', attrs: { d: 'M12 1.6l3.1 6.6 7.2.9-5.3 5 1.4 7.2L12 17.8l-6.4 3.5L7 14.1 1.7 9.1l7.2-.9z' } },
  { name: 'Квадрат', tag: 'rect', attrs: { x: 3, y: 3, width: 18, height: 18, rx: 2.5 } },
];

export function shapeIcon(index, className = 'shape') {
  const shape = ANSWER_SHAPES[index % ANSWER_SHAPES.length];
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const figure = document.createElementNS(SVG_NS, shape.tag);
  for (const [name, value] of Object.entries(shape.attrs)) figure.setAttribute(name, value);
  figure.setAttribute('fill', 'currentColor');
  svg.append(figure);
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
  hourglass: ['M6.5 3h11', 'M6.5 21h11', 'M8 3c0 5 8 5.6 8 9s-8 4-8 9', 'M16 3c0 5-8 5.6-8 9s8 4 8 9'],
};

export function stageIcon(name, className = 'stage-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const d of STAGE_ICONS[name] || []) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', name === 'play' ? 'currentColor' : 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.2');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
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
