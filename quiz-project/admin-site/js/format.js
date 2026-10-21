// Форматирование для админ-консоли.

const dateTime = new Intl.DateTimeFormat('ru-RU', { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

export const fmtDate = (iso) => (iso ? dateTime.format(new Date(iso)) : '—');

export function ago(iso) {
  if (!iso) return '—';
  const minutes = Math.round((Date.now() - new Date(iso).getTime()) / 60_000);
  if (minutes < 1) return 'только что';
  if (minutes < 60) return `${minutes} мин назад`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} ч назад`;
  const days = Math.round(hours / 24);
  if (days < 8) return `${days} дн назад`;
  return fmtDate(iso);
}

export const DEVICE_TYPES = {
  mobile: 'Телефон',
  tablet: 'Планшет',
  desktop: 'Компьютер',
  smarttv: 'Телевизор',
  console: 'Приставка',
  wearable: 'Часы',
  embedded: 'Устройство',
  other: 'Другое',
};

export const deviceType = (value) => DEVICE_TYPES[value] ?? '—';

export function deviceLabel({ deviceType: type, os, browser } = {}) {
  if (!type && !os && !browser) return '—';
  return [DEVICE_TYPES[type] ?? null, os, browser].filter(Boolean).join(' · ');
}

export const banTerm = (ban) => (ban.forever ? 'навсегда' : `до ${fmtDate(ban.endsAt)}`);

export const EVENT_LABELS = {
  account_register: 'Регистрация',
  account_login: 'Вход в аккаунт',
  account_recover: 'Восстановление доступа',
  quiz_create: 'Создана игра',
  room_create: 'Запущена комната',
  room_join: 'Вход в комнату',
};

export const AUDIT_LABELS = {
  'recovery_code.issue': 'Выдан одноразовый код',
  'ban.create': 'Блокировка',
  'ban.lift': 'Снятие блокировки',
  'account.view': 'Открыта карточка аккаунта',
  'visitor.view': 'Открыта карточка устройства',
  'settings.update': 'Изменены настройки',
  'sharing.hide': 'Скрыт из подозрительных',
  'backup.run': 'Резервная копия вручную',
  'sharing.unhide': 'Возвращён в подозрительные',
};

export const BAN_STATUS = { active: 'действует', expired: 'истекла', lifted: 'снята' };

export const SHARING_LEVELS = { green: 'зелёный', yellow: 'жёлтый', red: 'красный' };

export const shortId = (id) => (id ? String(id).slice(0, 8) : '—');

export const counts = ({ all, day, week }) => `${all} · ${day} · ${week}`;
