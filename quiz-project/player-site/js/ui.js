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

// Фигуры и цвета вариантов совпадают с экраном ведущего.
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

// Значки сцены (вместо эмодзи): рисуются линией текущего цвета.
const STAGE_ICONS = {
  check: ['M5 12.6l4.6 4.6L19.2 7.4'],
  cross: ['M6.6 6.6l10.8 10.8', 'M17.4 6.6 6.6 17.4'],
  hourglass: ['M6.5 3h11', 'M6.5 21h11', 'M8 3c0 5 8 5.6 8 9s-8 4-8 9', 'M16 3c0 5-8 5.6-8 9s8 4 8 9', 'M10 18.6h4'],
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
  for (const d of STAGE_ICONS[name] || STAGE_ICONS.alert) {
    const path = document.createElementNS(SVG_NS, 'path');
    path.setAttribute('d', d);
    path.setAttribute('fill', 'none');
    path.setAttribute('stroke', 'currentColor');
    path.setAttribute('stroke-width', '2.4');
    path.setAttribute('stroke-linecap', 'round');
    path.setAttribute('stroke-linejoin', 'round');
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
