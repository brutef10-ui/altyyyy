// Вход и регистрация ведущего. Проверки здесь — только подсказки; всё решает сервер.
import { SERVER_URL } from './config.js';
import { csrfToken, loadSession, safeNext, setAccount } from './auth.js';
import { api } from './api.js';
import { toast } from './ui.js';
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
  if (!response.ok) throw Object.assign(new Error(data?.error || `Ошибка сервера (${response.status})`), { code: data?.code });
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
    showError(error, err.message);
    $('login-password').select();
  }
});

// ---------- Регистрация ----------

function registerProblem(login, password, repeat) {
  if (!LOGIN_PATTERN.test(login)) return 'Логин: 3–32 символа, латинские буквы, цифры, «_», «.» или «-», начинается с буквы.';
  if (password.length < 8) return 'Пароль: не короче 8 символов.';
  if (!PRINTABLE_ASCII.test(password)) return 'Пароль: только латинские буквы, цифры и знаки (без кириллицы).';
  if (password !== repeat) return 'Пароли не совпадают.';
  return '';
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
    showError(error, err.message);
  }
});

// ---------- Резервный код (показывается один раз) ----------

function showBackupCode(account, code) {
  const step = $('backup-step');
  const groups = code.split('-');
  $('backup-code').replaceChildren(...groups.map((group, index) => {
    const span = document.createElement('span');
    span.textContent = index < groups.length - 1 ? `${group}-` : group;
    return span;
  }));
  sceneChange(card, () => {
    $('login-tabs').hidden = true;
    $('form-register').hidden = true;
    step.hidden = false;
  }, 'turntable').then(() => $('saved-check').focus());

  $('copy-code').onclick = async () => {
    try {
      await navigator.clipboard.writeText(code);
      toast('Код скопирован');
    } catch {
      toast('Не получилось скопировать — выделите код и скопируйте вручную', 'error');
    }
  };
  $('download-code').onclick = () => {
    const text = `AL Studio — резервный код\nЛогин: ${account.login}\nКод: ${code}\n\nКод нужен, чтобы восстановить доступ, если вы забудете пароль. Храните его в надёжном месте.\n`;
    const link = document.createElement('a');
    link.href = URL.createObjectURL(new Blob([text], { type: 'text/plain;charset=utf-8' }));
    link.download = `al-studio-${account.login}-backup-code.txt`;
    link.dataset.curtain = 'off';
    document.body.append(link);
    link.click();
    link.remove();
    setTimeout(() => URL.revokeObjectURL(link.href), 1_000);
  };
  $('saved-check').onchange = (event) => {
    $('backup-continue').disabled = !event.target.checked;
  };
  $('backup-continue').onclick = async () => {
    $('backup-continue').disabled = true;
    // Код больше не нужен на странице — убираем его до ухода.
    $('backup-code').textContent = '';
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
    if (session.account) {
      curtain.go(next, { replace: true });
      return;
    }
  } catch {
    showError($('login-error'), `Сервер недоступен (${SERVER_URL}). Обновите страницу чуть позже.`);
  }
  if (location.hash === '#register') selectTab($('tab-register'));
  try {
    const config = await api.getConfig();
    if (config.playerSiteUrl) $('player-link').href = config.playerSiteUrl;
  } catch {
    /* ссылка по умолчанию ведёт на сайт игрока рядом */
  }
  if (!matchMedia('(pointer: coarse)').matches) $('login-login').focus();
}

init();
