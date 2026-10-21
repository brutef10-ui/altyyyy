// Вход и регистрация ведущего. Проверки здесь — только подсказки; всё решает сервер.
import { SERVER_URL } from './config.js';
import { csrfToken, loadSession, safeNext, setAccount } from './auth.js';
import { api } from './api.js';
import { contactNode, copyCode, downloadCode, renderCode } from './codes.js';
import { banFromError, showBanned } from './banned.js';
import { curtain, sceneChange } from './theatre.js';

const LOGIN_PATTERN = /^[A-Za-z][A-Za-z0-9_.-]{2,31}$/;
const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;

const $ = (id) => document.getElementById(id);
const card = document.querySelector('.login-card');
const next = safeNext(new URLSearchParams(location.search).get('next'));

function showError(element, message) {
  element.textContent = message || '';
  element.hidden = !message;
}

async function post(path, body) {
  await loadSession();
  let response;
  try {
    response = await fetch(`${SERVER_URL}${path}`, {
      method: 'POST',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json', 'X-CSRF-Token': csrfToken() ?? '' },
      body: JSON.stringify(body),
    });
  } catch {
    throw new Error('Сервер недоступен. Проверьте соединение и попробуйте ещё раз.');
  }
  const data = await response.json().catch(() => null);
  if (response.status === 403 && data?.code === 'CSRF') {
    await loadSession({ force: true });
    throw new Error('Страница устарела — попробуйте ещё раз.');
  }
  if (!response.ok) throw Object.assign(new Error(data?.error || `Ошибка сервера (${response.status})`), { code: data?.code, details: data?.details });
  return data;
}

function busy(button, text) {
  const label = button.textContent;
  button.disabled = true;
  button.textContent = text;
  return () => {
    button.disabled = false;
    button.textContent = label;
  };
}

// ---------- Вкладки ----------

const tabs = [$('tab-login'), $('tab-register')];
const panels = { 'tab-login': $('form-login'), 'tab-register': $('form-register') };

function selectTab(tab, { focus = false } = {}) {
  if (tab.getAttribute('aria-selected') === 'true') return;
  for (const item of tabs) {
    const selected = item === tab;
    item.setAttribute('aria-selected', String(selected));
    item.tabIndex = selected ? 0 : -1;
  }
  const panel = panels[tab.id];
  // Новая форма скрыта, поэтому старая исчезает сразу, а новая «загорается».
  sceneChange(panel, () => {
    for (const [id, form] of Object.entries(panels)) form.hidden = id !== tab.id;
  }, 'lights').then(() => {
    if (focus) panel.querySelector('input')?.focus();
  });
  history.replaceState(null, '', tab.id === 'tab-register' ? '#register' : location.pathname + location.search);
}

for (const tab of tabs) {
  tab.addEventListener('click', () => selectTab(tab, { focus: true }));
  tab.addEventListener('keydown', (event) => {
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    const other = tabs.find((item) => item !== tab);
    other.focus();
    selectTab(other);
  });
}

// ---------- Вход ----------

$('form-login').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('login-error');
  const login = $('login-login').value.trim();
  const password = $('login-password').value;
  if (!login || !password) {
    showError(error, 'Введите логин и пароль');
    return;
  }
  showError(error, '');
  const done = busy($('login-submit'), 'Входим…');
  try {
    const { account } = await post('/api/auth/login', { login, password });
    setAccount(account);
    await checkLegacyGames();
    curtain.go(next, { replace: true });
  } catch (err) {
    done();
    if (banFromError(err)) {
      showBanned(banFromError(err));
      return;
    }
    showError(error, err.message);
    $('login-password').select();
  }
});

// ---------- Регистрация ----------

function passwordProblem(password, repeat) {
  if (password.length < 8) return 'Пароль: не короче 8 символов.';
  if (!PRINTABLE_ASCII.test(password)) return 'Пароль: только латинские буквы, цифры и знаки (без кириллицы).';
  if (password !== repeat) return 'Пароли не совпадают.';
  return '';
}

function registerProblem(login, password, repeat) {
  if (!LOGIN_PATTERN.test(login)) return 'Логин: 3–32 символа, латинские буквы, цифры, «_», «.» или «-», начинается с буквы.';
  return passwordProblem(password, repeat);
}

$('form-register').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('register-error');
  const login = $('register-login').value.trim();
  const password = $('register-password').value;
  const problem = registerProblem(login, password, $('register-password2').value);
  if (problem) {
    showError(error, problem);
    return;
  }
  showError(error, '');
  const done = busy($('register-submit'), 'Регистрируем…');
  try {
    const { account, backupCode } = await post('/api/auth/register', { login, password, website: $('register-website').value });
    setAccount(account);
    $('register-password').value = '';
    $('register-password2').value = '';
    showBackupCode(account, backupCode);
  } catch (err) {
    done();
    if (banFromError(err)) {
      showBanned(banFromError(err));
      return;
    }
    showError(error, err.message);
  }
});

// ---------- Восстановление доступа ----------

const loginForms = [$('form-login'), $('form-register'), $('form-recover')];

function showRecover(show) {
  const target = show ? $('form-recover') : $('form-login');
  sceneChange(target, () => {
    for (const form of loginForms) form.hidden = form !== target;
    $('login-tabs').hidden = show;
    if (!show) selectTab($('tab-login'));
  }, 'turntable').then(() => target.querySelector('input')?.focus());
}

$('forgot-link').addEventListener('click', () => {
  $('recover-login').value = $('login-login').value.trim();
  showRecover(true);
});
$('back-to-login').addEventListener('click', () => showRecover(false));

$('form-recover').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('recover-error');
  const login = $('recover-login').value.trim();
  const code = $('recover-code').value.trim();
  const password = $('recover-password').value;
  const problem = !login || !code ? 'Введите логин и код' : passwordProblem(password, $('recover-password2').value);
  if (problem) {
    showError(error, problem);
    return;
  }
  showError(error, '');
  const done = busy($('recover-submit'), 'Проверяем код…');
  try {
    const { account, backupCode, ban } = await post('/api/auth/recover', { login, code, newPassword: password });
    setAccount(account);
    for (const id of ['recover-code', 'recover-password', 'recover-password2']) $(id).value = '';
    // Пароль сменён, но аккаунт заблокирован: сначала новый код, потом экран блокировки.
    showBackupCode(account ?? { login }, backupCode, { recovered: true, ban });
  } catch (err) {
    done();
    if (banFromError(err)) {
      showBanned(banFromError(err));
      return;
    }
    showError(error, err.message);
  }
});

// ---------- Резервный код (показывается один раз) ----------

function showBackupCode(account, code, { recovered = false, ban = null } = {}) {
  const step = $('backup-step');
  if (recovered) {
    $('backup-kicker').textContent = 'Пароль изменён';
    $('backup-title').textContent = 'Сохраните новый резервный код';
  }
  renderCode($('backup-code'), code);
  sceneChange(card, () => {
    $('login-tabs').hidden = true;
    for (const form of loginForms) form.hidden = true;
    step.hidden = false;
  }, 'turntable').then(() => $('saved-check').focus());

  $('copy-code').onclick = () => copyCode(code);
  $('download-code').onclick = () => downloadCode(account.login, code);
  $('saved-check').onchange = (event) => {
    $('backup-continue').disabled = !event.target.checked;
  };
  $('backup-continue').onclick = async () => {
    $('backup-continue').disabled = true;
    // Код больше не нужен на странице — убираем его до ухода.
    $('backup-code').textContent = '';
    if (ban) {
      showBanned(ban);
      return;
    }
    await checkLegacyGames();
    curtain.go(next, { replace: true });
  };
}

// ---------- Игры, созданные в этом браузере до появления аккаунтов ----------

async function checkLegacyGames() {
  try {
    const count = await api.legacyCount();
    if (count > 0) sessionStorage.setItem('alstudio.host.legacy', String(count));
  } catch {
    /* не страшно: предложим на главной */
  }
}

// ---------- Старт ----------

async function init() {
  try {
    const session = await loadSession();
    if (session.ban) {
      showBanned(session.ban, { contact: session.adminContact });
      return;
    }
    if (session.account) {
      curtain.go(next, { replace: true });
      return;
    }
    if (session.adminContact) {
      $('admin-contact').replaceChildren(contactNode(session.adminContact));
      $('recover-contact').hidden = false;
    }
  } catch {
    showError($('login-error'), `Сервер недоступен (${SERVER_URL}). Обновите страницу чуть позже.`);
  }
  if (location.hash === '#register') selectTab($('tab-register'));
  if (location.hash === '#recover') showRecover(true);
  try {
    const config = await api.getConfig();
    if (config.playerSiteUrl) $('player-link').href = config.playerSiteUrl;
  } catch {
    /* ссылка по умолчанию ведёт на сайт игрока рядом */
  }
  if (!matchMedia('(pointer: coarse)').matches) $('login-login').focus();
}

init();
