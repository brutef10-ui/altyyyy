// Оплата доступа к созданию своих игр. Здесь только интерфейс: доступ открывает сервер,
// получив чек, и он же проверяет право создавать и запускать игры на каждом запросе.
//
// Шаги: предупреждение → QR-код и чек → «Доступ открыт».
import { api } from './api.js';
import { loadSession } from './auth.js';
import { h } from './ui.js';

const QR_SRC = 'img/payment-qr.jpg';
const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/jpeg', 'image/png', 'image/webp', 'application/pdf'];
// Большие фото уменьшаем в браузере: чек читается и в 1800 px, а загрузка быстрее.
const SHRINK_FROM_BYTES = 1.5 * 1024 * 1024;
const MAX_SIDE = 1800;

/** { required, amount, currency, canCreate } с сервера. */
export async function paymentInfo({ force = false } = {}) {
  const session = await loadSession({ force });
  return session.payment ?? { required: false, canCreate: true };
}

async function shrinkImage(file) {
  if (!file.type.startsWith('image/') || file.size <= SHRINK_FROM_BYTES || typeof createImageBitmap !== 'function') return file;
  try {
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d').drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close?.();
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    return blob && blob.size < file.size ? blob : file;
  } catch {
    return file;
  }
}

/**
 * Открыть оплату. Промис: true — доступ открыт, false — закрыли окно.
 * onDone — что сделать по кнопке «Создать игру» после оплаты.
 */
export function openPaymentFlow(info, { onDone = () => { location.href = 'editor.html'; } } = {}) {
  return new Promise((resolve) => {
    const price = `${info.amount} ${info.currency}`;
    const body = h('div', { class: 'payment-step' });
    const dialog = h('dialog', { class: 'modal payment-modal', 'aria-labelledby': 'payment-title' }, body);
    let paid = false;
    let previewUrl = null;

    const finish = () => {
      if (previewUrl) URL.revokeObjectURL(previewUrl);
      dialog.close();
      dialog.remove();
      resolve(paid);
    };
    dialog.addEventListener('cancel', (event) => {
      event.preventDefault();
      if (!dialog.classList.contains('is-busy')) finish();
    });
    const show = (...nodes) => {
      body.replaceChildren(...nodes);
      body.querySelector('[data-autofocus]')?.focus();
    };

    // ---------- Шаг 1: предупреждение ----------
    const intro = () => show(
      h('p', { class: 'kicker', text: 'Свои игры' }),
      h('h2', { class: 'modal-title', id: 'payment-title', text: 'Создание игр — платная услуга' }),
      h('p', { text: `Демо-игру можно запускать бесплатно, но менять её нельзя. Чтобы создавать свои игры и менять их сколько угодно, оплатите доступ — ${price}, один раз.` }),
      h('p', { class: 'payment-warning', role: 'note' },
        h('b', { text: 'Внимание: ' }),
        'каждый чек проверяет администратор. За поддельный или чужой чек аккаунт блокируется.'),
      h('div', { class: 'modal-actions' },
        h('button', { class: 'btn btn-ghost', type: 'button', text: 'Отмена', onclick: finish }),
        h('button', { class: 'btn btn-primary', type: 'button', text: 'Далее →', 'data-autofocus': '', onclick: pay }),
      ),
    );

    // ---------- Шаг 2: QR-код и чек ----------
    function pay() {
      let file = null;
      const error = h('p', { class: 'form-error', role: 'alert', hidden: true });
      const preview = h('div', { class: 'receipt-preview', hidden: true });
      const input = h('input', { class: 'receipt-input', type: 'file', id: 'receipt-file', accept: TYPES.join(','), 'aria-describedby': 'receipt-hint' });
      const submit = h('button', { class: 'btn btn-primary', type: 'button', text: 'Отправить чек', disabled: true });
      const showError = (message) => {
        error.textContent = message;
        error.hidden = !message;
      };

      input.addEventListener('change', () => {
        showError('');
        const chosen = input.files?.[0] ?? null;
        if (previewUrl) URL.revokeObjectURL(previewUrl);
        previewUrl = null;
        file = null;
        preview.hidden = true;
        submit.disabled = true;
        if (!chosen) return;
        if (!TYPES.includes(chosen.type)) {
          showError('Чек — фото или скриншот (JPEG, PNG, WebP) или PDF.');
          return;
        }
        file = chosen;
        const isImage = chosen.type.startsWith('image/');
        if (isImage) previewUrl = URL.createObjectURL(chosen);
        preview.replaceChildren(
          isImage ? h('img', { src: previewUrl, alt: 'Чек' }) : h('span', { class: 'receipt-pdf', text: 'PDF' }),
          h('span', { class: 'receipt-name', text: chosen.name }),
        );
        preview.hidden = false;
        submit.disabled = false;
      });

      submit.addEventListener('click', async () => {
        if (!file) return;
        showError('');
        submit.disabled = true;
        submit.textContent = 'Отправляем…';
        dialog.classList.add('is-busy');
        try {
          const blob = await shrinkImage(file);
          if (blob.size > MAX_BYTES) throw new Error('Файл больше 5 МБ — сделайте скриншот чека.');
          await api.uploadReceipt(blob);
          paid = true;
          await loadSession({ force: true }).catch(() => {});
          done();
        } catch (err) {
          showError(err.message);
          submit.textContent = 'Отправить чек';
          submit.disabled = false;
        } finally {
          dialog.classList.remove('is-busy');
        }
      });

      show(
        h('p', { class: 'kicker', text: 'Оплата' }),
        h('h2', { class: 'modal-title', id: 'payment-title', text: `Оплатите ${price}` }),
        h('div', { class: 'payment-grid' },
          h('figure', { class: 'payment-qr' },
            h('img', { src: QR_SRC, alt: `QR-код для оплаты ${price}`, width: 600, height: 600 }),
            h('a', { class: 'btn btn-ghost btn-small', href: QR_SRC, download: 'luminous-oplata-qr.jpg', text: 'Сохранить QR-код' }),
          ),
          h('ol', { class: 'payment-steps' },
            h('li', { text: 'Отсканируйте QR-код в приложении банка. Если платите с этого же телефона — сохраните QR-код и выберите его в приложении банка из галереи.' }),
            h('li', { text: `Оплатите ${price}.` }),
            h('li', { text: 'Прикрепите чек — скриншот или PDF из приложения банка. Доступ откроется сразу.' }),
          ),
        ),
        h('label', { class: 'receipt-drop', for: 'receipt-file' },
          h('span', { class: 'receipt-drop-title', text: 'Прикрепить чек' }),
          h('small', { id: 'receipt-hint', text: 'Фото, скриншот или PDF, до 5 МБ' }),
          input,
        ),
        preview,
        error,
        h('p', { class: 'payment-privacy' }, 'Чек видит только администратор; он хранится не дольше 2 суток. ',
          h('a', { href: '../privacy.html#payment', target: '_blank', rel: 'noopener', text: 'Подробнее' })),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', text: '← Назад', onclick: intro }),
          submit,
        ),
      );
    }

    // ---------- Шаг 3: готово ----------
    function done() {
      show(
        h('p', { class: 'kicker', text: 'Готово' }),
        h('h2', { class: 'modal-title', id: 'payment-title', text: 'Доступ открыт' }),
        h('p', { text: 'Спасибо! Теперь вы можете создавать свои игры и менять их сколько угодно.' }),
        h('div', { class: 'modal-actions' },
          h('button', { class: 'btn btn-ghost', type: 'button', text: 'Позже', onclick: finish }),
          h('button', { class: 'btn btn-primary', type: 'button', text: '+ Создать игру', 'data-autofocus': '', onclick: () => { finish(); onDone(); } }),
        ),
      );
    }

    document.body.append(dialog);
    dialog.showModal();
    intro();
  });
}
