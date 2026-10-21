// Карточка аккаунта или устройства: полная история, IP, устройства, ники, блокировки, игры.
// Открывается выезжающей панелью (на телефоне — на весь экран).
import { adminApi } from './api.js';
import { banDialog, issueCode, liftDialog } from './actions.js';
import { h, toast } from './dom.js';
import { BAN_STATUS, EVENT_LABELS, ago, banTerm, deviceLabel, deviceType, fmtDate, shortId } from './format.js';

let current = null; // { dialog, kind, id, onChange }

const empty = (text = 'Нет данных') => h('p', { class: 'muted empty-note', text });

function section(title, body, count = null) {
  return h('section', { class: 'card-section' },
    h('h3', { class: 'card-section-title' }, title, count === null ? null : h('span', { class: 'count-badge', text: String(count) })),
    body,
  );
}

function table(columns, rows) {
  if (!rows.length) return empty();
  return h('div', { class: 'table-wrap' },
    h('table', { class: 'mini-table' },
      h('thead', {}, h('tr', {}, columns.map((column) => h('th', { scope: 'col', text: column.title })))),
      h('tbody', {}, rows.map((row) => h('tr', {}, columns.map((column) => h('td', { dataset: { label: column.title } }, column.value(row)))))),
    ),
  );
}

function facts(items) {
  return h('dl', { class: 'facts' }, items.map(([term, value]) => h('div', {}, h('dt', { text: term }), h('dd', {}, value ?? '—'))));
}

function statusPill(ban) {
  return ban ? h('span', { class: 'pill pill-danger', text: `заблокирован ${banTerm(ban)}` }) : h('span', { class: 'pill pill-ok', text: 'активен' });
}

function bansSection(bans) {
  return section('Блокировки', bans.length ? h('ul', { class: 'ban-history' }, bans.map((ban) => h('li', { class: `ban-item is-${ban.status}` },
    h('div', { class: 'ban-item-head' },
      h('span', { class: `pill ${ban.status === 'active' ? 'pill-danger' : 'pill-muted'}`, text: BAN_STATUS[ban.status] }),
      h('b', { text: ban.reason }),
    ),
    h('p', { class: 'muted small' },
      `${fmtDate(ban.startsAt)} → ${ban.forever ? 'навсегда' : fmtDate(ban.endsAt)} · ${ban.createdBy ?? '—'}`,
      [ban.accountId ? ' · аккаунт' : '', ban.visitorId ? ` · устройство ${shortId(ban.visitorId)}` : '', ban.ip ? ` · IP ${ban.ip}` : ''].join(''),
      ban.liftedAt ? ` · снята ${fmtDate(ban.liftedAt)} (${ban.liftedBy ?? '—'})${ban.liftReason ? `: ${ban.liftReason}` : ''}` : '',
    ),
    ban.status === 'active' ? h('button', {
      class: 'btn btn-small btn-ghost',
      type: 'button',
      text: 'Разблокировать',
      onclick: async () => {
        if (await liftDialog(ban)) refresh();
      },
    }) : null,
  ))) : empty('Блокировок не было'), bans.length);
}

const ipTable = (ips) => table([
  { title: 'IP', value: (row) => h('code', { text: row.ip }) },
  { title: 'Первый раз', value: (row) => fmtDate(row.firstAt) },
  { title: 'Последний', value: (row) => fmtDate(row.lastAt) },
  { title: 'Раз', value: (row) => String(row.count) },
], ips);

const deviceTable = (devices) => table([
  { title: 'Устройство', value: (row) => deviceType(row.deviceType) },
  { title: 'ОС', value: (row) => row.os ?? '—' },
  { title: 'Браузер', value: (row) => row.browser ?? '—' },
  { title: 'Последний раз', value: (row) => fmtDate(row.lastAt) },
  { title: 'Раз', value: (row) => String(row.count) },
], devices);

const nicknameList = (nicknames) => (nicknames.length
  ? h('ul', { class: 'chips' }, nicknames.map((row) => h('li', { class: 'chip', title: `${row.count} раз, последний ${fmtDate(row.lastAt)}` }, row.nickname, h('small', { text: ` ×${row.count}` }))))
  : empty('Ник не вводился'));

function eventLine(event, { accountView = false } = {}) {
  const what = [EVENT_LABELS[event.type] ?? event.type];
  if (event.nickname) what.push(`«${event.nickname}»`);
  if (event.roomCode) what.push(`комната ${event.roomCode}`);
  if (event.details?.title) what.push(`«${event.details.title}»`);
  if (event.details?.method === 'admin') what.push('(код администратора)');
  return h('li', { class: 'event' },
    h('time', { class: 'event-time', datetime: event.createdAt, text: fmtDate(event.createdAt) }),
    h('div', { class: 'event-main' },
      h('span', { class: 'event-what', text: what.join(' ') }),
      accountView && !event.accountId ? h('span', { class: 'pill pill-muted', text: 'до регистрации / без входа' }) : null,
      !accountView && event.accountLogin ? h('span', { class: 'pill pill-muted', text: `вошёл как ${event.accountLogin}` }) : null,
    ),
    h('span', { class: 'event-meta muted', text: [event.ip ?? '—', deviceLabel(event), event.anonymized ? 'обезличено' : null].filter(Boolean).join(' · ') }),
  );
}

function eventsSection(params, { accountView = false } = {}) {
  const list = h('ul', { class: 'events' });
  const more = h('button', { class: 'btn btn-small btn-ghost', type: 'button', text: 'Показать ещё', hidden: true });
  let before = null;
  async function load() {
    more.disabled = true;
    try {
      const page = await adminApi.events({ ...params, before, limit: 50 });
      if (!page.items.length && !before) list.replaceWith(empty('Событий нет'));
      list.append(...page.items.map((event) => eventLine(event, { accountView })));
      before = page.nextBefore;
      more.hidden = !page.hasMore;
    } catch (error) {
      toast(error.message, 'error');
    } finally {
      more.disabled = false;
    }
  }
  more.addEventListener('click', load);
  load();
  return section('Журнал событий', h('div', {}, list, more));
}

function accountCard(card) {
  const { account } = card;
  const activeBan = card.bans.find((ban) => ban.status === 'active' && ban.accountId === account.id) ?? null;
  const lastVisitor = card.visitors[0] ?? null;
  const lastIp = card.ips[0]?.ip ?? null;
  const isAdmin = account.role === 'admin';
  return {
    kicker: isAdmin ? 'Аккаунт администратора' : 'Аккаунт',
    title: account.login,
    status: [statusPill(activeBan)],
    actions: isAdmin ? [] : [
      h('button', { class: 'btn btn-small btn-primary', type: 'button', text: 'Выдать одноразовый код', onclick: async () => { if (await issueCode(account)) refresh(); } }),
      h('button', {
        class: 'btn btn-small btn-danger',
        type: 'button',
        text: 'Заблокировать',
        onclick: async () => { if (await banDialog({ account, visitor: lastVisitor, ip: lastIp })) refresh(); },
      }),
    ],
    body: [
      section('Сведения', facts([
        ['Регистрация', fmtDate(account.createdAt)],
        ['Последний вход', fmtDate(account.lastLoginAt)],
        ['Пароль изменён', fmtDate(account.passwordChangedAt)],
        ['Резервный код выпущен', fmtDate(account.backupCodeCreatedAt)],
        ['Активных сессий', String(account.activeSessions)],
        ['До регистрации', card.beforeRegistration.events ? `${card.beforeRegistration.events} событий с ${fmtDate(card.beforeRegistration.firstAt)}` : 'нет гостевой истории'],
      ])),
      bansSection(card.bans),
      section('Устройства аккаунта (visitor_id)', table([
        { title: 'ID', value: (row) => h('button', { class: 'link-btn', type: 'button', text: row.shortId, title: row.id, onclick: () => openCard('visitor', row.id) }) },
        { title: 'Первый визит', value: (row) => fmtDate(row.firstSeenAt) },
        { title: 'Связано', value: (row) => fmtDate(row.linkedAt) },
        { title: 'Последний раз', value: (row) => ago(row.lastUsedAt) },
      ], card.visitors), card.visitors.length),
      section('IP-адреса', ipTable(card.ips), card.ips.length),
      section('Устройства и браузеры', deviceTable(card.devices), card.devices.length),
      section('Ники в играх', nicknameList(card.nicknames), card.nicknames.length),
      section('Созданные игры', card.games.length ? h('ul', { class: 'plain-list' }, card.games.map((game) => h('li', {},
        h('b', { text: game.title }), h('span', { class: 'muted', text: ` · ${game.questions} вопр. · изменена ${fmtDate(game.updatedAt)}` })))) : empty('Игр нет'), card.games.length),
      section('Запуски комнат', card.rooms.length ? h('ul', { class: 'plain-list' }, card.rooms.map((room) => h('li', {},
        h('code', { text: room.code }), ' ', h('span', { text: room.title ?? '' }), h('span', { class: 'muted', text: ` · ${fmtDate(room.createdAt)}` })))) : empty('Комнат не запускал'), card.rooms.length),
      section('Одноразовые коды', card.recoveryCodes.length ? h('ul', { class: 'plain-list' }, card.recoveryCodes.map((code) => h('li', {},
        `${fmtDate(code.createdAt)} — ${code.createdBy ?? '—'}: `, h('b', { text: codeStatus(code.status) }), h('span', { class: 'muted', text: ` · до ${fmtDate(code.expiresAt)} · неверных попыток: ${code.attempts}` })))) : empty('Не выдавались'), card.recoveryCodes.length),
      eventsSection({ accountId: account.id }, { accountView: true }),
    ],
  };
}

function codeStatus(status) {
  if (status === 'used') return 'использован';
  if (status === 'active') return 'действует';
  if (status === 'expired') return 'истёк';
  if (status.startsWith('revoked')) return status.includes('too-many') ? 'сгорел (попытки)' : 'отозван';
  return status;
}

function visitorCard(card) {
  const { visitor } = card;
  const activeBan = card.bans.find((ban) => ban.status === 'active' && ban.visitorId === visitor.id) ?? null;
  return {
    kicker: card.accounts.length ? 'Устройство (связано с аккаунтом)' : 'Устройство гостя',
    title: visitor.shortId,
    status: [statusPill(activeBan)],
    actions: [
      h('button', {
        class: 'btn btn-small btn-danger',
        type: 'button',
        text: 'Заблокировать',
        onclick: async () => { if (await banDialog({ visitor, ip: card.ips[0]?.ip ?? visitor.lastIp })) refresh(); },
      }),
    ],
    body: [
      section('Сведения', facts([
        ['Полный ID', h('code', { text: visitor.id })],
        ['Первый визит', fmtDate(visitor.firstSeenAt)],
        ['Последний визит', fmtDate(visitor.lastSeenAt)],
        ['Последний IP', visitor.lastIp ?? '—'],
        ['Входов в комнаты', String(visitor.joins)],
        ['Аккаунты', card.accounts.length ? h('span', {}, card.accounts.map((account, index) => [index ? ', ' : '', h('button', { class: 'link-btn', type: 'button', text: account.login, onclick: () => openCard('account', account.id) })])) : 'не входил'],
      ])),
      bansSection(card.bans),
      section('IP-адреса', ipTable(card.ips), card.ips.length),
      section('Устройства и браузеры', deviceTable(card.devices), card.devices.length),
      section('Ники в играх', nicknameList(card.nicknames), card.nicknames.length),
      eventsSection({ visitorId: visitor.id }),
    ],
  };
}

function shell() {
  const dialog = h('dialog', { class: 'drawer', 'aria-labelledby': 'drawer-title' });
  dialog.addEventListener('cancel', (event) => {
    event.preventDefault();
    closeCard();
  });
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeCard();
  });
  document.body.append(dialog);
  return dialog;
}

async function render() {
  const { dialog, kind, id } = current;
  dialog.replaceChildren(h('div', { class: 'drawer-panel' }, h('div', { class: 'drawer-loading' }, h('div', { class: 'spinner', 'aria-hidden': 'true' }), h('p', { class: 'muted', text: 'Загружаем…' }))));
  let view;
  try {
    view = kind === 'account' ? accountCard(await adminApi.account(id)) : visitorCard(await adminApi.visitor(id));
  } catch (error) {
    toast(error.message, 'error');
    closeCard();
    return;
  }
  if (!current || current.id !== id) return;
  dialog.replaceChildren(h('div', { class: 'drawer-panel' },
    h('header', { class: 'drawer-head' },
      h('div', { class: 'drawer-heading' },
        h('p', { class: 'kicker', text: view.kicker }),
        h('h2', { id: 'drawer-title', class: 'drawer-title', text: view.title }),
        h('div', { class: 'drawer-status' }, view.status),
      ),
      h('button', { class: 'icon-btn drawer-close', type: 'button', 'aria-label': 'Закрыть карточку', text: '×', onclick: closeCard }),
      view.actions.length ? h('div', { class: 'drawer-actions' }, view.actions) : null,
    ),
    h('div', { class: 'drawer-body' }, view.body),
  ));
}

function refresh() {
  if (!current) return;
  render();
  current.onChange?.();
}

export function openCard(kind, id, { onChange } = {}) {
  const dialog = current?.dialog ?? shell();
  current = { dialog, kind, id, onChange: onChange ?? current?.onChange };
  if (!dialog.open) dialog.showModal();
  dialog.scrollTop = 0;
  render();
}

export function closeCard() {
  if (!current) return;
  current.dialog.close();
  current.dialog.remove();
  current = null;
}
