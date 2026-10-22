// Админ-консоль: вкладки «Зарегистрированные», «Незарегистрированные», «Блокировки», «Журнал аудита».
// Сервер отдаёт эту страницу и данные только администратору; здесь — только интерфейс.
import { adminApi } from './api.js';
import { banDialog, issueCode, liftDialog } from './actions.js';
import { openCard } from './card.js';
import { confirmDialog, h, toast } from './dom.js';
import { AUDIT_LABELS, BAN_STATUS, SHARING_LEVELS, ago, deviceLabel, fmtDate, shortId } from './format.js';
import { curtain } from './theatre.js';

const $ = (id) => document.getElementById(id);

// ---------- Таблица со строками-карточками на узких экранах ----------

function ledger(columns) {
  const body = h('tbody');
  const table = h('table', { class: 'ledger-table' },
    h('thead', {}, h('tr', {}, columns.map((column) => h('th', { scope: 'col', class: column.className ?? null, title: column.hint ?? null, text: column.title })))),
    body,
  );
  const row = (item, onOpen) => h('tr', {
    class: onOpen ? 'is-clickable' : null,
    onclick: onOpen ? (event) => {
      if (event.target.closest('button, a, input, select')) return;
      onOpen(item);
    } : null,
  }, columns.map((column) => h('td', { class: column.className ?? null, dataset: { label: column.title } }, column.value(item))));
  return { table, body, row };
}

// Сколько разных IP и устройств у аккаунта: маленькая табличка «всего / сутки / неделя».
const SPREAD_PERIODS = [['all', 'всего', 'за всё время'], ['day', 'сутки', 'за последние 24 часа'], ['week', 'неделя', 'за последние 7 дней']];
const spread = (item) => h('div', { class: 'spread', role: 'table', 'aria-label': 'Разные IP-адреса и устройства' },
  h('span', { class: 'spread-head', role: 'columnheader' }),
  SPREAD_PERIODS.map(([, label]) => h('span', { class: 'spread-head', role: 'columnheader', text: label })),
  [['ips', 'IP-адреса', 'Разных IP-адресов'], ['devices', 'Устройства', 'Разных устройств (браузеров)']].map(([key, label, long]) => [
    h('span', { class: 'spread-label', role: 'rowheader', text: label }),
    SPREAD_PERIODS.map(([period, , when]) => h('span', { class: 'spread-num', role: 'cell', title: `${long} ${when}: ${item[key][period]}`, text: String(item[key][period]) })),
  ]));

const banPill = (ban) => (ban
  ? h('span', { class: 'pill pill-danger', title: ban.reason, text: `блок ${ban.forever ? 'навсегда' : `до ${fmtDate(ban.endsAt)}`}` })
  : null);

/**
 * Список с поиском, сортировкой и «Показать ещё».
 * load(params) → { items, hasMore }.
 */
function listView({ root, columns, load, onOpen, searchPlaceholder, sorts = null, filters = null, emptyText, before = [], onPage = null }) {
  const search = h('input', { class: 'input toolbar-search', type: 'search', placeholder: searchPlaceholder, 'aria-label': searchPlaceholder, maxlength: 64 });
  const sort = sorts ? h('select', { class: 'input select toolbar-select', 'aria-label': 'Сортировка' }, sorts.map(([value, label]) => h('option', { value, text: label }))) : null;
  const filter = filters ? h('div', { class: 'segmented', role: 'group', 'aria-label': 'Фильтр' }) : null;
  let filterValue = filters?.[0]?.[0] ?? null;
  if (filter) {
    for (const [value, label] of filters) {
      filter.append(h('button', {
        class: 'segmented-btn',
        type: 'button',
        'aria-pressed': String(value === filterValue),
        text: label,
        onclick: (event) => {
          filterValue = value;
          filter.querySelectorAll('button').forEach((button) => button.setAttribute('aria-pressed', String(button === event.currentTarget)));
          reload();
        },
      }));
    }
  }
  const { table, body, row } = ledger(columns);
  const emptyNote = h('p', { class: 'ledger-empty muted', text: emptyText, hidden: true });
  const more = h('button', { class: 'btn btn-ghost btn-small', type: 'button', text: 'Показать ещё', hidden: true });
  const status = h('p', { class: 'muted ledger-status', 'aria-live': 'polite' });
  root.replaceChildren(
    ...before,
    h('div', { class: 'toolbar' }, search, sort, filter),
    h('div', { class: 'ledger programme' }, h('div', { class: 'ledger-scroll' }, table), emptyNote),
    h('div', { class: 'ledger-foot' }, status, more),
  );

  let offset = 0;
  let generation = 0;
  async function fetchPage(reset) {
    const current = ++generation;
    if (reset) offset = 0;
    more.disabled = true;
    status.textContent = 'Загружаем…';
    try {
      const page = await load({ q: search.value.trim(), sort: sort?.value, filter: filterValue, offset, limit: 50 });
      if (current !== generation) return;
      onPage?.(page);
      if (reset) body.replaceChildren();
      body.append(...page.items.map((item) => row(item, onOpen)));
      offset += page.items.length;
      emptyNote.hidden = body.children.length > 0;
      more.hidden = !page.hasMore;
      status.textContent = body.children.length ? `Показано: ${body.children.length}` : '';
    } catch (error) {
      if (current !== generation) return;
      status.textContent = '';
      toast(error.message, 'error');
    } finally {
      more.disabled = false;
    }
  }
  const reload = () => fetchPage(true);
  let timer = null;
  search.addEventListener('input', () => {
    clearTimeout(timer);
    timer = setTimeout(reload, 300);
  });
  sort?.addEventListener('change', reload);
  more.addEventListener('click', () => fetchPage(false));
  return { reload };
}

// ---------- Вкладки ----------

const refreshers = {};
const refreshAll = () => {
  loadOverview();
  for (const refresh of Object.values(refreshers)) refresh?.();
};

// Метка подсказки о шаринге: цвет, оценка, причины во всплывающей подсказке.
function sharingPill(sharing) {
  if (!sharing) return h('span', { class: 'muted small', text: 'нет активности' });
  const title = sharing.reasons.length ? sharing.reasons.map((reason) => `• ${reason.text} (+${reason.weight})`).join('\n') : 'Признаков совместного использования нет';
  return h('span', { class: 'hint-cell' },
    h('span', { class: `pill hint-pill hint-${sharing.level}`, title, text: `${sharing.score} · ${SHARING_LEVELS[sharing.level]}` }),
    sharing.hidden ? h('span', { class: 'pill pill-muted', text: 'скрыт' }) : null);
}

// Переключатель подсказок: хранится на сервере, по умолчанию выключен.
function sharingControls(enabled, onToggle) {
  const toggle = h('button', {
    class: 'switch',
    type: 'button',
    role: 'switch',
    'aria-checked': String(enabled),
    onclick: async () => {
      toggle.disabled = true;
      try {
        await adminApi.setSharing(!enabled);
        toast(!enabled ? 'Подсказки включены' : 'Подсказки выключены');
        onToggle();
      } catch (error) {
        toast(error.message, 'error');
        toggle.disabled = false;
      }
    },
  }, h('span', { class: 'switch-track', 'aria-hidden': 'true' }, h('span', { class: 'switch-knob' })), h('span', { text: 'Искать аккаунты, которыми пользуются несколько человек' }));
  const note = h('p', { class: 'hint-note' }, enabled
    ? 'Включено: в таблице появилась колонка «Подсказка о шаринге» и фильтр «Подозрительные». Признаки — много разных устройств, разные города, две игры одновременно; наведите на оценку, чтобы увидеть причины. Подсказки ничего не блокируют и пользователям не показываются — это только повод присмотреться. Считаются по журналу за 30 дней.'
    : 'Необязательная подсказка: сервер может отмечать аккаунты, которыми, похоже, пользуются несколько человек (много разных устройств, разные города, две игры одновременно). Сейчас выключено — ничего не считается, на работу сайта это не влияет.');
  const status = h('p', { class: 'hint-status muted small', 'aria-live': 'polite' });
  const recompute = enabled ? h('button', {
    class: 'btn btn-ghost btn-small',
    type: 'button',
    text: 'Пересчитать',
    onclick: async (event) => {
      event.currentTarget.disabled = true;
      try {
        const result = await adminApi.recomputeSharing();
        toast(`Пересчитано: ${result.analyzed} аккаунтов, подозрительных — ${result.flagged}`);
        onToggle();
      } catch (error) {
        toast(error.message, 'error');
        event.currentTarget.disabled = false;
      }
    },
  }) : null;
  const panel = h('div', { class: `hint-panel${enabled ? ' is-on' : ''}` }, h('div', { class: 'hint-row' }, toggle, recompute), note, status);
  return {
    panel,
    showStatus(info) {
      status.textContent = info
        ? `Проанализировано аккаунтов: ${info.analyzed}${info.limited ? ' (ограничено — самые активные)' : ''} · ${fmtDate(info.computedAt)} · ${info.durationMs} мс. GeoIP: GeoLite (MaxMind), локальная база.`
        : '';
    },
  };
}

async function accountsTab() {
  let enabled = false;
  try {
    enabled = (await adminApi.settings()).sharingHints;
  } catch (error) {
    toast(error.message, 'error');
  }
  const controls = sharingControls(enabled, () => accountsTab());
  const hintColumn = { title: 'Подсказка о шаринге', value: (item) => sharingPill(item.sharing) };
  const view = listView({
    root: $('panel-accounts'),
    before: [controls.panel],
    onPage: (page) => controls.showStatus(page.sharing),
    searchPlaceholder: 'Логин, ник или IP',
    sorts: [['last_login', 'Сначала недавно входившие'], ['created', 'Сначала новые аккаунты']],
    filters: enabled ? [['all', 'Все'], ['suspicious', 'Подозрительные']] : null,
    emptyText: 'Аккаунтов не найдено',
    load: (params) => adminApi.accounts({ ...params, filter: undefined, suspicious: params.filter === 'suspicious' ? 1 : undefined }),
    onOpen: (item) => openCard('account', item.id, { onChange: refreshAll }),
    columns: [
      { title: 'Логин', className: 'col-main', value: (item) => h('div', { class: 'cell-main' },
        h('button', { class: 'link-btn cell-title', type: 'button', text: item.login, onclick: () => openCard('account', item.id, { onChange: refreshAll }) }),
        item.role === 'admin' ? h('span', { class: 'pill pill-gold', text: 'админ' }) : null,
        banPill(item.ban)) },
      { title: 'Регистрация', value: (item) => fmtDate(item.createdAt) },
      { title: 'Последний вход', value: (item) => h('span', { title: fmtDate(item.lastLoginAt), text: ago(item.lastLoginAt) }) },
      { title: 'Последний IP · устройство', value: (item) => h('div', { class: 'cell-stack' },
        h('code', { text: item.lastIp ?? '—' }),
        h('span', { class: 'cell-sub', text: deviceLabel(item) })) },
      { title: 'IP-адреса и устройства', className: 'num', hint: 'Сколько разных IP-адресов и устройств (браузеров) было у аккаунта: за всё время, за последние сутки и за неделю', value: (item) => spread(item) },
      ...(enabled ? [hintColumn] : []),
      { title: 'Действия', className: 'col-actions', value: (item) => (item.role === 'admin' ? '—' : h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Выдать одноразовый код', onclick: () => issueCode(item) }),
        h('button', { class: 'btn btn-small btn-danger', type: 'button', text: 'Заблокировать', onclick: async () => { if (await banDialog({ account: item, ip: item.lastIp })) refreshAll(); } }),
      )) },
    ],
  });
  refreshers.accounts = view.reload;
  view.reload();
}

function visitorsTab() {
  const view = listView({
    root: $('panel-visitors'),
    searchPlaceholder: 'ID устройства, ник или IP',
    sorts: [['last_seen', 'Сначала недавние'], ['first_seen', 'Сначала новые устройства']],
    emptyText: 'Гостей без аккаунта не найдено',
    load: (params) => adminApi.visitors(params),
    onOpen: (item) => openCard('visitor', item.id, { onChange: refreshAll }),
    columns: [
      { title: 'ID', className: 'col-main', value: (item) => h('div', { class: 'cell-main' },
        h('button', { class: 'link-btn cell-title mono', type: 'button', text: item.shortId, title: item.id, onclick: () => openCard('visitor', item.id, { onChange: refreshAll }) }),
        banPill(item.ban)) },
      { title: 'Ники', value: (item) => (item.nicknames.length ? item.nicknames.join(', ') : '—') },
      { title: 'Последний IP · устройство', value: (item) => h('div', { class: 'cell-stack' },
        h('code', { text: item.lastIp ?? '—' }),
        h('span', { class: 'cell-sub', text: deviceLabel(item) })) },
      { title: 'Первый визит', value: (item) => fmtDate(item.firstSeenAt) },
      { title: 'Последний визит', value: (item) => h('span', { title: fmtDate(item.lastSeenAt), text: ago(item.lastSeenAt) }) },
      { title: 'Входов в комнаты', className: 'num', value: (item) => String(item.joins) },
      { title: 'Действия', className: 'col-actions', value: (item) => h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-small btn-danger', type: 'button', text: 'Заблокировать', onclick: async () => { if (await banDialog({ visitor: item, ip: item.lastIp })) refreshAll(); } })) },
    ],
  });
  refreshers.visitors = view.reload;
  view.reload();
}

function banTarget(ban) {
  const parts = [];
  if (ban.accountId) parts.push(h('button', { class: 'link-btn', type: 'button', text: ban.accountLogin ?? shortId(ban.accountId), onclick: () => openCard('account', ban.accountId, { onChange: refreshAll }) }));
  if (ban.visitorId) parts.push(h('button', { class: 'link-btn mono', type: 'button', text: `устройство ${shortId(ban.visitorId)}`, onclick: () => openCard('visitor', ban.visitorId, { onChange: refreshAll }) }));
  if (ban.ip) parts.push(h('code', { text: `IP ${ban.ip}` }));
  return h('div', { class: 'cell-stack' }, parts);
}

function bansTab() {
  const view = listView({
    root: $('panel-bans'),
    searchPlaceholder: 'Поиск по списку на экране',
    filters: [['active', 'Действующие'], ['all', 'Вся история']],
    emptyText: 'Блокировок нет',
    load: async ({ filter, offset, limit, q }) => {
      const page = await adminApi.bans({ status: filter, offset, limit });
      const needle = q.toLowerCase();
      const items = needle ? page.bans.filter((ban) => [ban.accountLogin, ban.ip, ban.visitorId, ban.reason].some((value) => value && String(value).toLowerCase().includes(needle))) : page.bans;
      return { items, hasMore: page.hasMore };
    },
    columns: [
      { title: 'Кого', className: 'col-main', value: banTarget },
      { title: 'Причина', value: (ban) => ban.reason },
      { title: 'Срок', value: (ban) => (ban.forever ? 'навсегда' : `${fmtDate(ban.startsAt)} → ${fmtDate(ban.endsAt)}`) },
      { title: 'Кто', value: (ban) => ban.createdBy ?? '—' },
      { title: 'Статус', value: (ban) => h('span', { class: `pill ${ban.status === 'active' ? 'pill-danger' : 'pill-muted'}`, text: BAN_STATUS[ban.status] }),
      },
      { title: 'Снята', value: (ban) => (ban.liftedAt ? `${fmtDate(ban.liftedAt)} · ${ban.liftedBy ?? '—'}${ban.liftReason ? ` · ${ban.liftReason}` : ''}` : '—') },
      { title: 'Действия', className: 'col-actions', value: (ban) => (ban.status === 'active'
        ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Разблокировать', onclick: async () => { if (await liftDialog(ban)) refreshAll(); } })
        : '—') },
    ],
  });
  refreshers.bans = view.reload;
  view.reload();
}

function auditDetails(entry) {
  const details = entry.details ?? {};
  const parts = [];
  if (details.login) parts.push(`логин ${details.login}`);
  if (details.reason) parts.push(`причина: ${details.reason}`);
  if (details.forever) parts.push('навсегда');
  else if (details.durationMinutes) parts.push(`на ${Math.round(details.durationMinutes / 60)} ч`);
  if (details.ip) parts.push(`IP ${details.ip}`);
  if (details.expiresAt) parts.push(`действует до ${fmtDate(details.expiresAt)}`);
  if (details.key) parts.push(`${details.key}: ${JSON.stringify(details.value)}`);
  return parts.join(' · ') || '—';
}

// ---------- Оплаты: кто прикрепил чек ----------

// Чек: картинка — в окне поверх консоли, PDF — в новой вкладке. Открытие пишется в журнал аудита.
function showReceipt(item) {
  const url = adminApi.receiptUrl(item.id);
  if (item.receipt.type === 'application/pdf') {
    window.open(url, '_blank', 'noopener');
    return;
  }
  const dialog = h('dialog', { class: 'modal receipt-modal', 'aria-label': `Чек ${item.login}` });
  const close = () => {
    dialog.close();
    dialog.remove();
  };
  dialog.append(
    h('h2', { class: 'modal-title', text: `Чек: ${item.login}` }),
    h('p', { class: 'muted', text: `${fmtDate(item.createdAt)} · IP ${item.ip ?? '—'} · ${deviceLabel(item)}` }),
    h('img', { class: 'receipt-full', src: url, alt: `Чек об оплате от ${item.login}` }),
    h('div', { class: 'modal-actions' },
      h('a', { class: 'btn btn-ghost', href: url, target: '_blank', rel: 'noopener', text: 'Открыть отдельно' }),
      h('button', { class: 'btn btn-primary', type: 'button', text: 'Закрыть', onclick: close })),
  );
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    close();
  });
  document.body.append(dialog);
  dialog.showModal();
}

function paymentsTab() {
  const view = listView({
    root: $('panel-payments'),
    before: [h('div', { class: 'hint-panel is-on' },
      h('p', { class: 'hint-title', text: 'Доступ открывается сразу, как ведущий прикрепит чек' }),
      h('p', { class: 'hint-note', text: 'Проверьте чек: сумма, получатель и время. Если чек поддельный или чужой — заблокируйте аккаунт. Чеки хранятся 2 суток и удаляются сами; запись об оплате (логин, время, IP, браузер) остаётся.' }))],
    searchPlaceholder: 'Логин или IP',
    emptyText: 'Оплат пока нет',
    load: (params) => adminApi.payments({ q: params.q, offset: params.offset, limit: params.limit }),
    onOpen: (item) => openCard('account', item.accountId, { onChange: refreshAll }),
    columns: [
      { title: 'Логин', className: 'col-main', value: (item) => h('div', { class: 'cell-main' },
        h('button', { class: 'link-btn cell-title', type: 'button', text: item.login, onclick: () => openCard('account', item.accountId, { onChange: refreshAll }) }),
        banPill(item.ban)) },
      { title: 'Когда', value: (item) => h('div', { class: 'cell-stack' },
        h('span', { text: fmtDate(item.createdAt) }),
        h('span', { class: 'cell-sub', text: ago(item.createdAt) })) },
      { title: 'IP · браузер', value: (item) => h('div', { class: 'cell-stack' },
        h('code', { text: item.ip ?? '—' }),
        h('span', { class: 'cell-sub', text: deviceLabel(item) })) },
      { title: 'Сумма', className: 'num', value: (item) => `${item.amount} ${item.currency}` },
      { title: 'Чек', value: (item) => (item.receipt
        ? h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: item.receipt.type === 'application/pdf' ? 'Открыть PDF' : 'Посмотреть чек', onclick: () => showReceipt(item) })
        : h('span', { class: 'cell-sub', text: 'удалён (прошло 2 суток)' })) },
      { title: 'Действия', className: 'col-actions', value: (item) => h('div', { class: 'row-actions' },
        h('button', { class: 'btn btn-small btn-danger', type: 'button', text: item.ban ? 'Ещё блокировка' : 'Заблокировать', onclick: async () => {
          if (await banDialog({ account: { id: item.accountId, login: item.login }, visitor: item.visitorId ? { id: item.visitorId } : null, ip: item.ip })) refreshAll();
        } })) },
    ],
  });
  refreshers.payments = view.reload;
  view.reload();
}

// ---------- Устройства, с которых можно входить в консоль ----------

async function devicesTab() {
  const root = $('panel-devices');
  let data;
  try {
    data = await adminApi.devices();
  } catch (error) {
    root.replaceChildren(h('p', { class: 'ledger-empty muted', text: error.message }));
    return;
  }
  const free = Math.max(0, data.max - data.devices.length);
  const note = h('div', { class: 'hint-panel is-on' },
    h('p', { class: 'hint-title', text: `Вход в консоль — только с этих устройств (не больше ${data.max})` }),
    h('p', { class: 'hint-note', text: 'С любого другого устройства вход не пройдёт, даже с верным логином и паролем, а попытка появится в журнале аудита. '
      + 'Чтобы войти с нового устройства, сначала уберите здесь одно из старых: свободное место займёт первое устройство, с которого вы войдёте. '
      + 'Если очистить в браузере данные сайта (cookie), сайт будет считать его новым устройством.' }),
    h('p', { class: 'hint-note', text: 'Потеряли все устройства? В Render → Environment задайте переменную ADMIN_DEVICE_RESET любым новым словом: после перезапуска список очистится, и места займут следующие входы.' }),
    h('p', { class: 'hint-status', text: free ? `Свободных мест: ${free} — его займёт следующий вход администратора.` : 'Свободных мест нет.' }),
  );
  const { table, body, row } = ledger([
    { title: 'Устройство', className: 'col-main', value: (device) => h('div', { class: 'cell-main' },
      h('span', { class: 'cell-title', text: deviceLabel(device) }),
      device.current ? h('span', { class: 'pill pill-gold', text: 'это устройство' }) : null) },
    { title: 'Добавлено', value: (device) => fmtDate(device.addedAt) },
    { title: 'Последний вход', value: (device) => h('span', { title: fmtDate(device.lastSeenAt), text: ago(device.lastSeenAt) }) },
    { title: 'IP', value: (device) => h('code', { text: device.lastIp ?? '—' }) },
    { title: 'Действия', className: 'col-actions', value: (device) => h('div', { class: 'row-actions' },
      h('button', { class: 'btn btn-small btn-danger', type: 'button', text: 'Убрать', onclick: () => removeDevice(device) })) },
  ]);
  body.replaceChildren(...data.devices.map((device) => row(device)));
  root.replaceChildren(note, h('div', { class: 'ledger programme' }, h('div', { class: 'ledger-scroll' }, table),
    data.devices.length ? null : h('p', { class: 'ledger-empty muted', text: 'Пока ни одного устройства.' })));
}

async function removeDevice(device) {
  const confirmed = await confirmDialog({
    title: 'Убрать устройство?',
    message: device.current
      ? 'Это устройство, с которого вы сейчас в консоли: вход на нём сразу завершится. Вернуться можно, только пока есть свободное место.'
      : `${deviceLabel(device)}: вход в консоль на нём сразу завершится, место освободится.`,
    confirmText: 'Убрать',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await adminApi.removeDevice(device.id);
  } catch (error) {
    toast(error.message, 'error');
    return;
  }
  if (device.current) {
    curtain.go('/host/login.html', { replace: true });
    return;
  }
  toast('Устройство убрано');
  devicesTab();
}

function auditTab() {
  const view = listView({
    root: $('panel-audit'),
    searchPlaceholder: 'Поиск по списку на экране',
    emptyText: 'Записей нет',
    load: async ({ offset, limit, q }) => {
      const page = await adminApi.audit({ offset, limit });
      const needle = q.toLowerCase();
      const items = needle ? page.items.filter((entry) => [entry.admin, entry.action, AUDIT_LABELS[entry.action], entry.targetId, auditDetails(entry)].some((value) => value && String(value).toLowerCase().includes(needle))) : page.items;
      return { items, hasMore: page.hasMore };
    },
    columns: [
      { title: 'Когда', value: (entry) => fmtDate(entry.createdAt) },
      { title: 'Администратор', value: (entry) => entry.admin ?? '—' },
      { title: 'Действие', className: 'col-main', value: (entry) => AUDIT_LABELS[entry.action] ?? entry.action },
      { title: 'Цель', value: (entry) => {
        if (entry.targetType === 'account' && entry.targetId) return h('button', { class: 'link-btn', type: 'button', text: entry.details?.login ?? `аккаунт ${shortId(entry.targetId)}`, onclick: () => openCard('account', entry.targetId, { onChange: refreshAll }) });
        if (entry.targetType === 'visitor' && entry.targetId) return h('button', { class: 'link-btn mono', type: 'button', text: `устройство ${shortId(entry.targetId)}`, onclick: () => openCard('visitor', entry.targetId, { onChange: refreshAll }) });
        return entry.targetId ?? '—';
      } },
      { title: 'Подробности', value: auditDetails },
      { title: 'IP', value: (entry) => h('code', { text: entry.ip ?? '—' }) },
    ],
  });
  refreshers.audit = view.reload;
  view.reload();
}

const TABS = {
  accounts: { init: accountsTab },
  visitors: { init: visitorsTab },
  bans: { init: bansTab },
  audit: { init: auditTab },
  payments: { init: paymentsTab },
  devices: { init: devicesTab },
};
const started = new Set();

function selectTab(name, { focus = false } = {}) {
  const key = TABS[name] ? name : 'accounts';
  for (const tab of document.querySelectorAll('.admin-tab')) {
    const selected = tab.dataset.tab === key;
    tab.setAttribute('aria-selected', String(selected));
    tab.tabIndex = selected ? 0 : -1;
    if (selected && focus) tab.focus();
  }
  for (const id of Object.keys(TABS)) $(`panel-${id}`).hidden = id !== key;
  if (!started.has(key)) {
    started.add(key);
    TABS[key].init();
  } else if (key === 'audit') {
    refreshers.audit?.();
  } else if (key === 'devices') {
    devicesTab();
  }
  history.replaceState(null, '', `#${key}`);
}

function bindTabs() {
  const tabs = [...document.querySelectorAll('.admin-tab')];
  tabs.forEach((tab, index) => {
    tab.addEventListener('click', () => selectTab(tab.dataset.tab));
    tab.addEventListener('keydown', (event) => {
      const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) return;
      event.preventDefault();
      selectTab(tabs[(index + step + tabs.length) % tabs.length].dataset.tab, { focus: true });
    });
  });
}

function showBackup(backup) {
  const line = $('backup-line');
  const status = $('backup-status');
  line.hidden = false;
  line.classList.toggle('is-bad', Boolean(backup.configured && backup.ok === false) || !backup.configured);
  if (!backup.configured) {
    status.textContent = 'Резервные копии не настроены: задайте BACKUP_ENCRYPTION_KEY и доступ к Google Drive в настройках сервера.';
    $('backup-run').hidden = true;
    return;
  }
  $('backup-run').hidden = false;
  if (!backup.attemptAt) status.textContent = 'Резервные копии настроены, первая копия будет сделана в ближайшие минуты.';
  else if (backup.ok) status.textContent = `Последняя резервная копия: ${fmtDate(backup.successAt)} — ${backup.rows} строк, ${Math.round((backup.size ?? 0) / 1024)} КБ, проверена после загрузки.`;
  else status.textContent = `Резервная копия НЕ удалась ${fmtDate(backup.attemptAt)}: ${backup.error ?? 'ошибка'}.${backup.successAt ? ` Последняя удачная — ${fmtDate(backup.successAt)}.` : ''}`;
}

async function loadOverview() {
  try {
    const stats = await adminApi.overview();
    showBackup(stats.backup);
    $('stat-accounts').textContent = stats.accounts;
    $('stat-guests').textContent = stats.guests;
    $('stat-bans').textContent = stats.active_bans;
    $('stat-joins').textContent = stats.joins_24h;
    $('count-accounts').textContent = stats.accounts;
    $('count-visitors').textContent = stats.guests;
    $('count-bans').textContent = stats.active_bans;
    $('count-payments').textContent = stats.payments;
  } catch (error) {
    toast(error.message, 'error');
  }
}

async function init() {
  const session = await adminApi.session();
  if (!session.account || session.account.role !== 'admin') {
    curtain.go(`/host/login.html?next=${encodeURIComponent('/admin/')}`, { replace: true });
    return;
  }
  $('admin-name').textContent = session.account.login;
  $('logout').addEventListener('click', async (event) => {
    event.currentTarget.disabled = true;
    try {
      await adminApi.logout();
    } finally {
      curtain.go('/host/login.html', { replace: true });
    }
  });
  bindTabs();
  loadOverview();
  $('backup-run').addEventListener('click', async (event) => {
    const button = event.currentTarget;
    button.disabled = true;
    button.textContent = 'Копируем…';
    try {
      const { backup } = await adminApi.runBackup();
      showBackup(backup);
      toast(backup.ok ? 'Резервная копия сделана и проверена' : `Копия не удалась: ${backup.error}`, backup.ok ? 'success' : 'error');
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      button.disabled = false;
      button.textContent = 'Сделать копию сейчас';
    }
  });
  selectTab(location.hash.slice(1));
  window.addEventListener('hashchange', () => selectTab(location.hash.slice(1)));
}

init().catch((error) => toast(error.message, 'error'));
