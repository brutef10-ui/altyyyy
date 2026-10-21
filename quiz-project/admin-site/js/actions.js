// Действия администратора: одноразовый код, блокировка, снятие блокировки.
// Сервер проверяет права, пишет каждое действие в журнал аудита и сам применяет блокировку.
import { adminApi } from './api.js';
import { h, openDialog, toast } from './dom.js';
import { fmtDate, shortId } from './format.js';

const DURATIONS = [
  { value: 60, label: '1 час' },
  { value: 24 * 60, label: '1 день' },
  { value: 7 * 24 * 60, label: '7 дней' },
  { value: 30 * 24 * 60, label: '30 дней' },
  { value: 365 * 24 * 60, label: '1 год' },
  { value: 'forever', label: 'Навсегда' },
];

/** Одноразовый код восстановления для аккаунта. Код показывается один раз. */
export async function issueCode(account) {
  let issued = null;
  const result = await openDialog({
    title: 'Выдать одноразовый код?',
    content: [
      h('p', { class: 'muted' }, 'Код для аккаунта ', h('b', { text: account.login }), '. Пользователь вводит его на странице входа → «Забыли пароль?» вместе с новым паролем. Прежние неиспользованные коды перестанут действовать.'),
    ],
    actions: [{ text: 'Отмена', value: false, kind: 'ghost' }, { text: 'Выдать код', value: true }],
    async onAction(value) {
      if (!value) return true;
      try {
        issued = await adminApi.issueCode(account.id);
      } catch (error) {
        toast(error.message, 'error');
      }
      return true;
    },
  });
  if (!result || !issued) return false;
  const code = h('p', { class: 'issued-code' });
  for (const [index, group] of issued.code.split('-').entries()) code.append(h('span', { text: index ? `-${group}` : group }));
  await openDialog({
    title: 'Код выдан',
    content: [
      h('p', { class: 'muted' }, 'Передайте код пользователю ', h('b', { text: issued.login }), '. Он показан один раз и больше нигде не хранится в открытом виде.'),
      code,
      h('p', { class: 'muted', text: `Действует до ${fmtDate(issued.expiresAt)} (${issued.ttlMinutes} мин), один раз, не больше 5 неверных попыток.` }),
    ],
    actions: [
      { text: 'Скопировать', value: 'copy', kind: 'ghost' },
      { text: 'Готово', value: 'done' },
    ],
    async onAction(value) {
      if (value !== 'copy') return true;
      try {
        await navigator.clipboard.writeText(issued.code);
        toast('Код скопирован');
      } catch {
        toast('Не получилось скопировать — выделите код вручную', 'error');
      }
      return false;
    },
  });
  return true;
}

/**
 * Блокировка. targets — что можно выбрать: { account: { id, login }, visitor: { id }, ip }.
 * Возвращает созданную блокировку или null.
 */
export async function banDialog(targets) {
  const checks = [];
  const option = (key, label, value, { checked = false, note = '' } = {}) => {
    const input = h('input', { type: 'checkbox', checked });
    checks.push({ key, value, input });
    return h('label', { class: 'check-row' }, input, h('span', {}, label, note ? h('small', { class: 'muted', text: note }) : null));
  };
  const options = [];
  if (targets.account) options.push(option('accountId', `Аккаунт «${targets.account.login}»`, targets.account.id, { checked: true, note: 'вход и создание игр с любого устройства' }));
  if (targets.visitor) options.push(option('visitorId', `Устройство ${shortId(targets.visitor.id)}`, targets.visitor.id, { checked: !targets.account, note: 'этот браузер: и как гость, и после входа' }));
  if (targets.ip) options.push(option('ip', `IP ${targets.ip}`, targets.ip, { note: 'осторожно: по одному IP могут выходить все игроки одной Wi-Fi сети' }));

  const reason = h('textarea', { class: 'input textarea', rows: 3, maxlength: 500, placeholder: 'Например: оскорбительные ники' });
  const duration = h('select', { class: 'input select' }, DURATIONS.map((item) => h('option', { value: String(item.value), text: item.label })));
  duration.value = String(24 * 60);
  const error = h('p', { class: 'form-error', role: 'alert', hidden: true });

  let created = null;
  await openDialog({
    title: 'Заблокировать',
    content: [
      h('fieldset', { class: 'ban-targets' }, h('legend', { class: 'field-label', text: 'Кого блокировать' }), options),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Причина (её увидит пользователь)' }), reason),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Срок' }), duration),
      error,
    ],
    actions: [{ text: 'Отмена', value: false, kind: 'ghost' }, { text: 'Заблокировать', value: true, kind: 'danger' }],
    async onAction(value) {
      if (!value) return true;
      const body = { reason: reason.value.trim() };
      for (const { key, value: target, input } of checks) if (input.checked) body[key] = target;
      if (!body.accountId && !body.visitorId && !body.ip) {
        error.textContent = 'Отметьте, кого блокировать.';
        error.hidden = false;
        return false;
      }
      if (body.reason.length < 3) {
        error.textContent = 'Укажите причину (от 3 символов).';
        error.hidden = false;
        reason.focus();
        return false;
      }
      if (duration.value === 'forever') body.forever = true;
      else body.durationMinutes = Number(duration.value);
      try {
        created = (await adminApi.createBan(body)).ban;
        toast('Блокировка действует. Заблокированные уже отключены от игр.', 'success');
        return true;
      } catch (err) {
        error.textContent = err.message;
        error.hidden = false;
        return false;
      }
    },
  });
  return created;
}

/** Снять блокировку (запись остаётся в истории). */
export async function liftDialog(ban) {
  const reason = h('input', { class: 'input', maxlength: 500, placeholder: 'Необязательно' });
  let lifted = null;
  await openDialog({
    title: 'Снять блокировку?',
    content: [
      h('p', { class: 'muted' }, 'Причина блокировки: ', h('b', { text: ban.reason })),
      h('label', { class: 'field' }, h('span', { class: 'field-label', text: 'Комментарий к снятию' }), reason),
    ],
    actions: [{ text: 'Отмена', value: false, kind: 'ghost' }, { text: 'Разблокировать', value: true }],
    async onAction(value) {
      if (!value) return true;
      try {
        lifted = (await adminApi.liftBan(ban.id, reason.value.trim())).ban;
        toast('Блокировка снята', 'success');
      } catch (error) {
        toast(error.message, 'error');
        return false;
      }
      return true;
    },
  });
  return lifted;
}
