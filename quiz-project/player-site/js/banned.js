// Экран «Вы заблокированы». Файл одинаковый на сайте ведущего и игрока.
//
// Блокирует и проверяет сервер; этот экран только показывает то, что сервер прислал:
// причину, срок (или «навсегда») и контакт администратора. Когда срок выходит, страница
// перезагружается сама — сервер снова пустит.
const MAX_TIMER_MS = 24 * 24 * 60 * 60_000; // setTimeout не умеет дольше ~24,8 суток

let shownFor = null;

const LOCK_ICON = '<svg class="banned-lock" viewBox="0 0 72 72" aria-hidden="true"><path d="M22 32V24a14 14 0 0 1 28 0v8" fill="none" stroke="#8f6a22" stroke-width="6" stroke-linecap="round"/><path d="M22 32V24a14 14 0 0 1 28 0v8" fill="none" stroke="#f3d98b" stroke-width="2" stroke-linecap="round"/><rect x="13" y="31" width="46" height="34" rx="7" fill="#8c1529" stroke="#5c0c1b" stroke-width="2"/><rect x="17" y="35" width="38" height="26" rx="5" fill="none" stroke="#d8ac4c" stroke-width="1.5"/><circle cx="36" cy="45" r="5" fill="#f3d98b"/><path d="M34 48h4l1.5 8h-7z" fill="#f3d98b"/></svg>';

/** Блокировка из ошибки сервера: REST (details), ответ Socket.IO (ban) или connect_error (data.ban). */
export function banFromError(error) {
  if (!error) return null;
  if (error.data?.code === 'BANNED') return error.data.ban ?? {};
  if (error.code !== 'BANNED') return null;
  return error.details ?? error.ban ?? {};
}

export const isBannedShown = () => shownFor !== null;

function formatEnd(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return '';
  return `до ${new Intl.DateTimeFormat('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(date)}`;
}

function contactNode(contact) {
  const value = String(contact || '').trim();
  if (/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) {
    const link = document.createElement('a');
    link.href = `mailto:${value}`;
    link.textContent = value;
    link.dataset.curtain = 'off';
    return link;
  }
  return document.createTextNode(value);
}

function fact(term, text) {
  const row = document.createElement('div');
  const dt = document.createElement('dt');
  const dd = document.createElement('dd');
  dt.textContent = term;
  dd.textContent = text;
  row.append(dt, dd);
  return row;
}

/** Показать экран блокировки поверх страницы. ban: { reason, endsAt, forever, contact }. */
export function showBanned(ban = {}, { contact = null } = {}) {
  const key = JSON.stringify([ban.reason, ban.endsAt, ban.forever]);
  if (shownFor === key) return;
  shownFor = key;
  document.querySelector('.banned-screen')?.remove();

  const screen = document.createElement('div');
  screen.className = 'banned-screen';
  screen.setAttribute('role', 'alertdialog');
  screen.setAttribute('aria-modal', 'true');
  screen.setAttribute('aria-labelledby', 'banned-title');

  const card = document.createElement('div');
  card.className = 'programme banned-card';
  card.tabIndex = -1;
  card.insertAdjacentHTML('afterbegin', LOCK_ICON);

  const kicker = document.createElement('p');
  kicker.className = 'kicker';
  kicker.textContent = 'Вход закрыт';
  const title = document.createElement('h1');
  title.id = 'banned-title';
  title.textContent = 'Вы заблокированы';

  const facts = document.createElement('dl');
  facts.className = 'banned-facts';
  facts.append(fact('Причина', ban.reason || 'не указана'));
  facts.append(fact('Срок', ban.forever || !ban.endsAt ? 'навсегда' : formatEnd(ban.endsAt)));

  card.append(kicker, title, facts);
  const adminContact = ban.contact || contact;
  if (adminContact) {
    const note = document.createElement('p');
    note.className = 'banned-contact';
    note.append('Если это ошибка, напишите администратору: ', contactNode(adminContact));
    card.append(note);
  }
  screen.append(card);

  // Остальная страница недоступна для клавиатуры и экранных дикторов.
  for (const child of document.body.children) {
    if (!child.classList.contains('curtain')) child.inert = true;
  }
  document.body.append(screen);
  card.focus();

  if (!ban.forever && ban.endsAt) {
    const wait = new Date(ban.endsAt).getTime() - Date.now() + 2_000;
    if (wait > 0 && wait < MAX_TIMER_MS) setTimeout(() => location.reload(), wait);
  }
}
