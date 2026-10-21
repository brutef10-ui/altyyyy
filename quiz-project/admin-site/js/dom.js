// Построение DOM и диалоги админ-консоли. Пользовательские данные — только textContent.

export function h(tag, props = {}, ...children) {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(props || {})) {
    if (value === undefined || value === null || value === false) continue;
    if (key === 'class') node.className = value;
    else if (key === 'text') node.textContent = value;
    else if (key === 'value') node.value = value;
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

let toasts = null;

export function toast(message, type = 'info', timeoutMs = 4200) {
  toasts ??= document.body.appendChild(h('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' }));
  const item = h('div', { class: `toast toast-${type}`, text: message });
  toasts.append(item);
  setTimeout(() => {
    item.classList.add('is-leaving');
    item.addEventListener('animationend', () => item.remove(), { once: true });
  }, timeoutMs);
}

/**
 * Модальный диалог. content — узлы тела; actions — [{ text, value, kind }], kind: primary | danger | ghost.
 * onAction(value, dialog) может вернуть false, чтобы не закрывать (например, при ошибке формы).
 */
export function openDialog({ title, content = [], actions = [], onAction = null, wide = false }) {
  return new Promise((resolve) => {
    const buttons = actions.map((action) => h('button', {
      class: `btn ${action.kind === 'danger' ? 'btn-danger' : action.kind === 'ghost' ? 'btn-ghost' : 'btn-primary'}`,
      type: 'button',
      text: action.text,
      dataset: { value: String(action.value) },
    }));
    const dialog = h('dialog', { class: `modal admin-modal${wide ? ' is-wide' : ''}`, 'aria-labelledby': 'modal-title' },
      h('h2', { class: 'modal-title', id: 'modal-title', text: title }),
      h('div', { class: 'modal-body' }, content),
      h('div', { class: 'modal-actions' }, buttons),
    );
    const finish = (value) => {
      dialog.close();
      dialog.remove();
      resolve(value);
    };
    buttons.forEach((button, index) => button.addEventListener('click', async () => {
      const { value } = actions[index];
      if (onAction) {
        buttons.forEach((item) => { item.disabled = true; });
        let keep = false;
        try {
          keep = (await onAction(value, dialog)) === false;
        } finally {
          buttons.forEach((item) => { item.disabled = false; });
        }
        if (keep) return;
      }
      finish(value);
    }));
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      finish(null);
    });
    document.body.append(dialog);
    dialog.showModal();
    (dialog.querySelector('input, textarea, select') ?? buttons.at(-1))?.focus();
  });
}

export async function confirmDialog({ title, message, confirmText = 'Да', danger = false }) {
  const result = await openDialog({
    title,
    content: [h('p', { class: 'muted', text: message })],
    actions: [{ text: 'Отмена', value: false, kind: 'ghost' }, { text: confirmText, value: true, kind: danger ? 'danger' : 'primary' }],
  });
  return result === true;
}
