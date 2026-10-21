// Маленькие помощники интерфейса игрока. Тексты от пользователей вставляются только как textContent.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'dataset') Object.assign(node.dataset, value);
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

// Карандаш — значок вопроса, на который отвечают вручную.
export function pencilIcon(className = 'shape') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  const path = document.createElementNS(SVG_NS, 'path');
  path.setAttribute('d', 'M3.5 20.5l1.2-4.6L15.6 5a2.2 2.2 0 0 1 3.1 0l.3.3a2.2 2.2 0 0 1 0 3.1L8.1 19.3zM14 7.6l2.4 2.4');
  path.setAttribute('fill', 'none');
  path.setAttribute('stroke', 'currentColor');
  path.setAttribute('stroke-width', '2.2');
  path.setAttribute('stroke-linecap', 'round');
  path.setAttribute('stroke-linejoin', 'round');
  svg.append(path);
  return svg;
}

// Значки сцены (вместо эмодзи): рисуются текущим цветом — линией или заливкой.
const STAGE_ICONS = {
  check: ['M5 12.6l4.6 4.6L19.2 7.4'],
  cross: ['M6.6 6.6l10.8 10.8', 'M17.4 6.6 6.6 17.4'],
  hourglass: [
    { d: 'M4.8 2.6h14.4a1.05 1.05 0 0 1 0 2.1H4.8a1.05 1.05 0 0 1 0-2.1zM4.8 19.3h14.4a1.05 1.05 0 0 1 0 2.1H4.8a1.05 1.05 0 0 1 0-2.1z', fill: true },
    { d: 'M5.9 4.7v14.6M18.1 4.7v14.6', width: 1.4 },
    { d: 'M8.1 4.7c0 4.4 3.1 5.4 3.1 7.3s-3.1 2.9-3.1 7.3M15.9 4.7c0 4.4-3.1 5.4-3.1 7.3s3.1 2.9 3.1 7.3', width: 1.6 },
    { d: 'M8.8 19.3c.4-2.5 1.8-3.8 3.2-4.1 1.4.3 2.8 1.6 3.2 4.1z', fill: true },
    { d: 'M12 12.7v2.3', width: 1.1 },
  ],
  alert: ['M12 6.5v7', 'M12 17.4v.2'],
  curtain: ['M3.5 21V8a5 5 0 0 1 5-5h7a5 5 0 0 1 5 5v13', 'M3.5 8c3.2 1.4 4.3 6.3 3.2 13', 'M20.5 8c-3.2 1.4-4.3 6.3-3.2 13', 'M2.5 21h19'],
  'curtain-closed': ['M3.5 21V8a5 5 0 0 1 5-5h7a5 5 0 0 1 5 5v13', 'M12 4v17', 'M7.5 6v15', 'M16.5 6v15', 'M2.5 21h19'],
  phone: ['M8.5 2.8h7a1.6 1.6 0 0 1 1.6 1.6v15.2a1.6 1.6 0 0 1-1.6 1.6h-7a1.6 1.6 0 0 1-1.6-1.6V4.4a1.6 1.6 0 0 1 1.6-1.6z', 'M11 18h2'],
  door: ['M4 21h16', 'M6.5 21V4.2c0-.7.6-1.2 1.2-1.2h8.6c.7 0 1.2.5 1.2 1.2V21', 'M14 12.2v.2'],
};

export function stageIcon(name, className = 'stage-icon') {
  const svg = document.createElementNS(SVG_NS, 'svg');
  svg.setAttribute('viewBox', '0 0 24 24');
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('class', className);
  for (const part of STAGE_ICONS[name] || STAGE_ICONS.alert) {
    // Часть — строка (линия) или { d, fill, width } (заливка или линия своей толщины).
    const { d, fill = false, width = 2.4 } = typeof part === 'string' ? { d: part } : part;
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    if (fill) {
      path.setAttribute('fill', 'currentColor');
    } else {
      path.setAttribute('fill', 'none');
      path.setAttribute('stroke', 'currentColor');
      path.setAttribute('stroke-width', String(width));
      path.setAttribute('stroke-linecap', 'round');
      path.setAttribute('stroke-linejoin', 'round');
    }
    svg.append(path);
  }
  return svg;
}

export function showError(element, message) {
  element.textContent = message || '';
  element.hidden = !message;
  if (message) {
    element.classList.remove('shake');
    void element.offsetWidth;
    element.classList.add('shake');
  }
}

export function vibrate(pattern) {
  try {
    navigator.vibrate?.(pattern);
  } catch {
    /* вибрация недоступна */
  }
}

export const formatScore = (score) => Number(score || 0).toLocaleString('ru-RU');

export function plural(count, [one, few, many]) {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (mod10 === 1 && mod100 !== 11) return one;
  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return few;
  return many;
}
