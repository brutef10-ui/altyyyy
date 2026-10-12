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
