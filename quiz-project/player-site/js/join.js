// Шаги входа: 1 — код комнаты (index.html), 3 — ник (name.html).
// Шаг 2 (селфи) — в camera.js. Данные уходят на сервер одним событием player:join на play.html.
import { api, flash, goTo, NICKNAME_MAX, nicknameError, normalizeNickname, playerState } from './session.js';
import { showError } from './ui.js';

// ---------- Шаг 1: код комнаты ----------

function initCodeStep() {
  const form = document.getElementById('code-form');
  const input = document.getElementById('code');
  const submit = document.getElementById('submit');
  const error = document.getElementById('error');

  const digits = () => input.value.replace(/\D/g, '').slice(0, 6);
  const format = (value) => (value.length > 3 ? `${value.slice(0, 3)} ${value.slice(3)}` : value);

  const sync = () => {
    const value = digits();
    input.value = format(value);
    submit.disabled = value.length !== 6;
  };

  input.addEventListener('input', () => {
    showError(error, '');
    sync();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const code = digits();
    if (code.length !== 6) {
      showError(error, 'Код комнаты — это 6 цифр');
      return;
    }
    submit.disabled = true;
    submit.textContent = 'Проверяем…';
    try {
      const room = await api(`/api/rooms/${code}`);
      const state = playerState.get();
      // Новая комната — забываем токен прошлой игры, но оставляем фото и ник.
      if (state.code !== code || !state.token) playerState.leaveRoom();
      playerState.patch({ code, title: room.title });
      location.href = 'photo.html';
    } catch (err) {
      showError(error, err.message);
      submit.textContent = 'Войти';
      submit.disabled = false;
      input.focus();
    }
  });

  const fromLink = new URLSearchParams(location.search).get('code');
  input.value = (fromLink || '').replace(/\D/g, '').slice(0, 6);
  sync();
  const message = flash.take();
  if (message) showError(error, message);
  input.focus();
}

// ---------- Шаг 3: ник ----------

function initNameStep() {
  const state = playerState.get();
  if (!state.code) {
    goTo('index.html', 'Сначала введите код комнаты');
    return;
  }
  if (!state.photo) {
    goTo('photo.html', 'Сначала сделайте селфи');
    return;
  }

  const form = document.getElementById('name-form');
  const input = document.getElementById('nickname');
  const submit = document.getElementById('submit');
  const error = document.getElementById('error');
  const counter = document.getElementById('counter');

  document.getElementById('avatar').src = state.photo;
  document.getElementById('room-title').textContent = state.title ? `Игра «${state.title}»` : '';

  const sync = () => {
    const length = [...input.value.trim()].length;
    counter.textContent = `${length}/${NICKNAME_MAX}`;
    const problem = nicknameError(input.value);
    submit.disabled = Boolean(problem);
    // Пока ник короткий — не ругаемся, показываем ошибку только про недопустимые символы.
    showError(error, problem && length >= 2 ? problem : '');
  };

  input.addEventListener('input', sync);

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const problem = nicknameError(input.value);
    if (problem) {
      showError(error, problem);
      return;
    }
    const nickname = normalizeNickname(input.value);
    submit.disabled = true;
    submit.textContent = 'Проверяем…';
    try {
      const result = await api(`/api/rooms/${state.code}/nickname`, { method: 'POST', body: { nickname } });
      playerState.patch({ nickname: result.nickname });
      location.href = 'play.html';
    } catch (err) {
      if (err.code === 'ROOM_NOT_FOUND' || err.code === 'GAME_STARTED' || err.code === 'ROOM_FULL') {
        playerState.leaveRoom();
        goTo('index.html', err.message);
        return;
      }
      showError(error, err.message);
      submit.textContent = 'Готово — в игру!';
      submit.disabled = false;
      input.focus();
    }
  });

  input.value = state.nickname || '';
  sync();
  const message = flash.take();
  if (message) showError(error, message);
  input.focus();
}

if (document.body.dataset.page === 'code') initCodeStep();
else if (document.body.dataset.page === 'name') initNameStep();
