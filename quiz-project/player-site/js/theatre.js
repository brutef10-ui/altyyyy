// Театральные переходы (см. DESIGN.md → motion). Файл одинаковый на сайте ведущего и игрока.
//
// Занавес: разметка .curtain стоит первой в <body>, CSS открывает его сам при загрузке страницы,
// поэтому страница не зависит от скрипта. Скрипт закрывает занавес перед уходом со страницы:
// curtain.go(url) и любая обычная ссылка на этот же сайт.
//
// Смена декораций внутри страницы — sceneChange(element, update, kind):
//   'turntable' — поворотный круг: старое уезжает поворотом, новое выезжает с другой стороны;
//   'fly'       — задник с колосников: старое поднимается вверх, новое опускается сверху;
//   'lights'    — свет: старое гаснет, новое загорается.
// stagger(elements) — ступенчатое появление частей сцены.
// Анимируются только transform и opacity; при prefers-reduced-motion — короткое растворение.

const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
export const prefersReducedMotion = () => reducedMotion.matches;

export const EASE_OUT = 'cubic-bezier(.22, 1, .36, 1)';
export const EASE_CURTAIN = 'cubic-bezier(.65, 0, .35, 1)';
export const EASE_SPRING = 'cubic-bezier(.34, 1.56, .64, 1)';

const CLOSE_MS = 860;

// ---------- Занавес ----------

function curtainNode() {
  let node = document.querySelector('.curtain');
  if (!node) {
    node = document.createElement('div');
    node.className = 'curtain is-open';
    node.setAttribute('aria-hidden', 'true');
    const folds = '<i></i>'.repeat(8);
    node.innerHTML = `<div class="curtain-drape curtain-left">${folds}</div><div class="curtain-drape curtain-right">${folds}</div><div class="curtain-valance"></div>`;
    document.body.prepend(node);
  }
  return node;
}

let leaving = false;

export const curtain = {
  /** Открыть занавес (например, когда «Назад» вернул страницу из кэша с закрытым занавесом). */
  open() {
    leaving = false;
    const node = curtainNode();
    node.classList.remove('is-closing', 'is-open');
    void node.offsetWidth;
    node.classList.add('is-reopening');
  },

  /** Закрыть занавес. Промис выполняется, когда кулисы сошлись. */
  close() {
    const node = curtainNode();
    if (prefersReducedMotion()) {
      node.classList.add('is-closing');
      return new Promise((resolve) => setTimeout(resolve, 160));
    }
    node.classList.remove('is-reopening', 'is-open');
    node.classList.add('is-closing');
    return new Promise((resolve) => setTimeout(resolve, CLOSE_MS));
  },

  /** Перейти на другую страницу через закрытие занавеса. */
  async go(url, { replace = false } = {}) {
    if (leaving) return;
    leaving = true;
    await curtain.close();
    if (replace) location.replace(url);
    else location.href = url;
  },
};

// Страница из кэша «Назад/Вперёд» приходит с закрытым занавесом — открываем снова.
window.addEventListener('pageshow', (event) => {
  if (event.persisted) curtain.open();
});

// Обычные ссылки внутри сайта тоже уходят через занавес.
document.addEventListener('click', (event) => {
  if (event.defaultPrevented || event.button !== 0) return;
  if (event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
  const link = event.target instanceof Element ? event.target.closest('a[href]') : null;
  if (!link || link.target || link.hasAttribute('download') || link.dataset.curtain === 'off') return;
  const url = new URL(link.href, location.href);
  if (url.origin !== location.origin) return;
  if (url.pathname === location.pathname && url.search === location.search && url.hash) return;
  event.preventDefault();
  curtain.go(url.href);
});

// ---------- Смена декораций ----------

const SCENES = {
  turntable: {
    out: [
      { transform: 'perspective(1400px) rotateY(0deg)', opacity: 1 },
      { transform: 'perspective(1400px) rotateY(-78deg) translateZ(-120px)', opacity: 0 },
    ],
    in: [
      { transform: 'perspective(1400px) rotateY(78deg) translateZ(-120px)', opacity: 0 },
      { transform: 'perspective(1400px) rotateY(0deg)', opacity: 1 },
    ],
    outMs: 340,
    inMs: 560,
  },
  fly: {
    out: [
      { transform: 'translateY(0)', opacity: 1 },
      { transform: 'translateY(-70%)', opacity: 0 },
    ],
    in: [
      { transform: 'translateY(-40%)', opacity: 0 },
      { transform: 'translateY(4%)', opacity: 1, offset: 0.72 },
      { transform: 'translateY(0)', opacity: 1 },
    ],
    outMs: 320,
    inMs: 620,
  },
  lights: {
    out: [
      { transform: 'scale(1)', opacity: 1 },
      { transform: 'scale(.97)', opacity: 0 },
    ],
    in: [
      { transform: 'scale(1.03)', opacity: 0 },
      { transform: 'scale(1)', opacity: 1 },
    ],
    outMs: 260,
    inMs: 480,
  },
};

const FADE = {
  out: [{ opacity: 1 }, { opacity: 0 }],
  in: [{ opacity: 0 }, { opacity: 1 }],
  outMs: 120,
  inMs: 180,
};

// Для каждого блока — последняя смена декораций и её анимации (чтобы новая смена убрала хвосты старой).
const running = new WeakMap();

async function play(element, entry, keyframes, duration, easing) {
  if (!element.animate) return;
  const animation = element.animate(keyframes, { duration, easing, fill: 'both' });
  entry.animations.push(animation);
  try {
    await animation.finished;
  } catch {
    /* анимацию прервала следующая смена декораций */
  }
}

function settle(entry) {
  entry.animations.forEach((animation) => animation.cancel());
  entry.animations.length = 0;
}

async function applyUpdate(entry) {
  if (entry.updated) return;
  entry.updated = true;
  await entry.update?.();
}

/**
 * Сменить содержимое блока как смену декораций.
 * update() вызывается, когда старая сцена ушла; может вернуть промис. Он выполняется всегда:
 * если новая смена началась раньше, чем ушла старая сцена, обновления применяются по порядку без анимации ухода.
 * Если element скрыт (hidden или display: none), update() выполняется сразу, а новая сцена только выезжает.
 */
export async function sceneChange(element, update, kind = 'turntable') {
  const scene = prefersReducedMotion() ? FADE : (SCENES[kind] || SCENES.turntable);
  const previous = running.get(element);
  const entry = { animations: [], update, updated: false };
  running.set(element, entry);
  if (previous) {
    settle(previous);
    await applyUpdate(previous);
  }
  const visible = !previous && element.getClientRects().length > 0;
  if (visible) await play(element, entry, scene.out, scene.outMs, 'cubic-bezier(.55, 0, .75, .2)');
  if (running.get(element) !== entry) return;
  await applyUpdate(entry);
  if (running.get(element) !== entry) return;
  await play(element, entry, scene.in, scene.inMs, EASE_OUT);
  if (running.get(element) !== entry) return;
  settle(entry);
  running.delete(element);
}

/**
 * Только выезд новой сцены — когда содержимое уже обновлено и ждать ухода старой нельзя
 * (например, следующий вопрос: таймеры идут с первой секунды).
 */
export function sceneIn(element, kind = 'turntable') {
  const scene = prefersReducedMotion() ? FADE : (SCENES[kind] || SCENES.turntable);
  if (!element.animate) return Promise.resolve();
  return element.animate(scene.in, { duration: scene.inMs, easing: EASE_OUT }).finished.catch(() => {});
}

/**
 * Ступенчатое появление: каждая часть выходит на сцену чуть позже предыдущей.
 * kind: 'rise' — поднимается из люка с наклоном, 'drop' — опускается сверху, 'flip' — переворачивается как табличка.
 */
export function stagger(elements, { step = 70, delay = 0, kind = 'rise', duration = 560 } = {}) {
  const list = Array.from(elements || []).filter(Boolean);
  const reduced = prefersReducedMotion();
  const from = {
    rise: 'perspective(900px) translateY(26px) rotateX(-28deg)',
    drop: 'perspective(900px) translateY(-30px) rotateX(24deg)',
    flip: 'perspective(900px) rotateY(-80deg)',
  }[kind] || 'translateY(20px)';
  return Promise.all(list.map((element, index) => {
    if (!element.animate) return null;
    const keyframes = reduced
      ? [{ opacity: 0 }, { opacity: 1 }]
      : [{ opacity: 0, transform: from }, { opacity: 1, transform: 'none' }];
    const animation = element.animate(keyframes, {
      duration: reduced ? 180 : duration,
      delay: reduced ? 0 : delay + index * step,
      easing: EASE_OUT,
      fill: 'backwards',
    });
    return animation.finished.catch(() => {});
  }));
}

/** Перезапустить CSS-анимацию, привязанную к классу. */
export function replay(element, className) {
  element.classList.remove(className);
  void element.offsetWidth;
  element.classList.add(className);
}
