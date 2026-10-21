// Админ-консоль: вкладки «Зарегистрированные», «Незарегистрированные», «Блокировки», «Журнал аудита».
// Сервер отдаёт эту страницу и данные только администратору; здесь — только интерфейс.
import { adminApi } from './api.js';
import { banDialog, issueCode, liftDialog } from './actions.js';
import { openCard } from './card.js';
import { h, toast } from './dom.js';
import { AUDIT_LABELS, BAN_STATUS, ago, banTerm, counts, deviceLabel, fmtDate, shortId } from './format.js';
import { curtain } from './theatre.js';

const $ = (id) => document.getElementById(id);

// ---------- Таблица со строками-карточками на узких экранах ----------

function ledger(columns) {
  const body = h('tbody');
  const table = h('table', { class: 'ledger-table' },
    h('thead', {}, h('tr', {}, columns.map((column) => h('th', { scope: 'col', class: column.className ?? null, text: column.title })))),
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

const banPill = (ban) => (ban
  ? h('span', { class: 'pill pill-danger', title: ban.reason, text: `блок ${ban.forever ? 'навсегда' : `до ${fmtDate(ban.endsAt)}`}` })
  : null);

/**
 * Список с поиском, сортировкой и «Показать ещё».
 * load(params) → { items, hasMore }.
 */
function listView({ root, columns, load, onOpen, searchPlaceholder, sorts = null, filters = null, emptyText }) {
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

function accountsTab() {
  const view = listView({
    root: $('panel-accounts'),
    searchPlaceholder: 'Логин, ник или IP',
    sorts: [['last_login', 'Сначала недавно входившие'], ['created', 'Сначала новые аккаунты']],
    emptyText: 'Аккаунтов не найдено',
    load: (params) => adminApi.accounts(params),
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
      { title: 'Разных IP и устройств: всего · 24 ч · 7 дн', className: 'num', value: (item) => h('div', { class: 'cell-stack' },
        h('span', {}, h('span', { class: 'cell-sub', text: 'IP ' }), counts(item.ips)),
        h('span', {}, h('span', { class: 'cell-sub', text: 'устр. ' }), counts(item.devices))) },
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

async function loadOverview() {
  try {
    const stats = await adminApi.overview();
    $('stat-accounts').textContent = stats.accounts;
    $('stat-guests').textContent = stats.guests;
    $('stat-bans').textContent = stats.active_bans;
    $('stat-joins').textContent = stats.joins_24h;
    $('count-accounts').textContent = stats.accounts;
    $('count-visitors').textContent = stats.guests;
    $('count-bans').textContent = stats.active_bans;
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
  selectTab(location.hash.slice(1));
}

init().catch((error) => toast(error.message, 'error'));
