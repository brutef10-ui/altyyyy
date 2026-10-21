// Аккаунт ведущего: смена пароля, новый резервный код, выход на всех устройствах.
// Все проверки (текущий пароль, лимиты попыток, права) выполняет сервер.
import { api } from './api.js';
import { logout, requireAccount } from './auth.js';
import { copyCode, downloadCode, renderCode } from './codes.js';
import { confirmDialog, toast } from './ui.js';
import { curtain, sceneChange } from './theatre.js';

const PRINTABLE_ASCII = /^[\x20-\x7E]*$/;
const $ = (id) => document.getElementById(id);

function showError(element, message) {
  element.textContent = message || '';
  element.hidden = !message;
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

function passwordProblem(password, repeat) {
  if (password.length < 8) return 'Пароль: не короче 8 символов.';
  if (!PRINTABLE_ASCII.test(password)) return 'Пароль: только латинские буквы, цифры и знаки (без кириллицы).';
  if (password !== repeat) return 'Пароли не совпадают.';
  return '';
}

let account = null;

$('password-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('password-error');
  const currentPassword = $('current-password').value;
  const newPassword = $('new-password').value;
  const problem = !currentPassword ? 'Введите текущий пароль' : passwordProblem(newPassword, $('new-password2').value);
  if (problem) {
    showError(error, problem);
    return;
  }
  showError(error, '');
  const done = busy($('password-submit'), 'Меняем…');
  try {
    await api.changePassword(currentPassword, newPassword);
    for (const id of ['current-password', 'new-password', 'new-password2']) $(id).value = '';
    toast('Пароль изменён. На других устройствах нужно войти заново.');
  } catch (err) {
    showError(error, err.message);
  } finally {
    done();
  }
});

$('backup-form').addEventListener('submit', async (event) => {
  event.preventDefault();
  const error = $('backup-error');
  const currentPassword = $('backup-password').value;
  if (!currentPassword) {
    showError(error, 'Введите текущий пароль');
    return;
  }
  showError(error, '');
  const done = busy($('backup-submit'), 'Выпускаем…');
  try {
    const code = await api.newBackupCode(currentPassword);
    $('backup-password').value = '';
    renderCode($('backup-code'), code);
    $('copy-code').onclick = () => copyCode(code);
    $('download-code').onclick = () => downloadCode(account.login, code);
    await sceneChange($('backup-card'), () => {
      $('backup-form').hidden = true;
      $('backup-result').hidden = false;
    }, 'turntable');
  } catch (err) {
    showError(error, err.message);
  } finally {
    done();
  }
});

$('backup-done').addEventListener('click', () => {
  sceneChange($('backup-card'), () => {
    $('backup-code').textContent = '';
    $('backup-result').hidden = true;
    $('backup-form').hidden = false;
  }, 'turntable');
});

$('logout').addEventListener('click', (event) => {
  event.currentTarget.disabled = true;
  logout();
});

$('logout-all').addEventListener('click', async () => {
  const confirmed = await confirmDialog({
    title: 'Выйти на всех устройствах?',
    message: 'Вход закроется везде, включая это устройство. Идущие игры, запущенные с других устройств, продолжатся, но управлять ими можно будет только после нового входа.',
    confirmText: 'Выйти везде',
    danger: true,
  });
  if (!confirmed) return;
  try {
    await api.logoutAll();
    curtain.go('login.html', { replace: true });
  } catch (err) {
    toast(err.message, 'error');
  }
});

async function init() {
  account = await requireAccount();
  if (!account) return;
  $('account-login').textContent = account.login;
  document.title = `AL Studio — ${account.login}`;
  if (account.role === 'admin') {
    $('account-note').textContent = 'Это аккаунт администратора: пароль и восстановление доступа задаются в настройках сервера.';
    for (const id of ['password-form', 'backup-card']) {
      $(id).classList.add('is-disabled');
      $(id).querySelectorAll('input, button').forEach((element) => {
        element.disabled = true;
      });
    }
  }
}

init();
