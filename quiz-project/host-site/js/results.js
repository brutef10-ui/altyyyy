// Итоги игры: пьедестал, рейтинг, сохранение игры, повторный запуск.
import { api } from './api.js';
import { editorDraft, hostSession } from './session.js';
import { closeRoom, launchGame, openHostRoom } from './socket.js';
import { avatar, confirmDialog, formatScore, h, plural, toast } from './ui.js';

const saveButton = document.getElementById('save');
const podium = document.getElementById('podium');
const ranking = document.getElementById('ranking');
let socket = null;
let rendered = false;

// ---------- Пьедестал и рейтинг ----------

function podiumPlace(row, player, place) {
  return h('div', { class: `podium-place place-${place}`, style: { animationDelay: `${(3 - place) * 350}ms` } },
    h('div', { class: 'podium-person' },
      avatar(player?.avatar, row.nickname, 'avatar avatar-xl'),
      h('span', { class: 'podium-name', text: row.nickname }),
      h('span', { class: 'podium-score', text: `${formatScore(row.score)} очк.` }),
    ),
    h('div', { class: 'podium-block' }, h('span', { text: row.rank })),
  );
}

function render(final, playersById) {
  document.getElementById('quiz-title').textContent = final.title;
  document.getElementById('player-total').textContent = `${final.playerCount} ${plural(final.playerCount, ['игрок', 'игрока', 'игроков'])}`;
  document.title = `AL Studio — итоги: ${final.title}`;

  const top = final.leaderboard.slice(0, 3);
  // Порядок на пьедестале: 2-е место, 1-е, 3-е.
  const order = [top[1], top[0], top[2]].filter(Boolean);
  podium.replaceChildren(...order.map((row) => podiumPlace(row, playersById.get(row.id), top.indexOf(row) + 1)));
  if (top.length === 0) podium.append(h('p', { class: 'muted', text: 'В игре не осталось игроков.' }));

  ranking.replaceChildren(...final.leaderboard.map((row) =>
    h('li', { class: 'ranking-row' },
      h('span', { class: 'ranking-rank', text: row.rank }),
      avatar(playersById.get(row.id)?.avatar, row.nickname, 'avatar avatar-sm'),
      h('span', { class: 'ranking-name', text: row.nickname }),
      h('span', { class: 'ranking-correct muted', text: `${row.correctCount} из ${final.totalQuestions} верно` }),
      h('span', { class: 'ranking-score', text: formatScore(row.score) }),
    ),
  ));

  document.getElementById('results').hidden = false;
  if (!rendered && top.length) launchConfetti();
  rendered = true;
}

// ---------- Сохранение ----------

function updateSaveButton() {
  const session = hostSession.get();
  saveButton.hidden = false;
  if (session?.draft) {
    saveButton.disabled = false;
    saveButton.textContent = session.quizId ? '💾 Сохранить изменения' : '💾 Сохранить игру';
  } else {
    saveButton.disabled = true;
    saveButton.textContent = '✓ Игра сохранена';
  }
}

saveButton.addEventListener('click', async () => {
  const session = hostSession.get();
  if (!session?.draft) return;
  saveButton.disabled = true;
  try {
    const saved = session.quizId
      ? await api.updateQuiz(session.quizId, session.draft)
      : await api.createQuiz(session.draft);
    if (!session.quizId) editorDraft.clear();
    hostSession.patch({ quizId: saved.id, draft: null });
    toast('Игра сохранена — она появится в списке на главной', 'success');
  } catch (error) {
    toast(error.details?.[0] || error.message, 'error', 6000);
  }
  updateSaveButton();
});

// ---------- Навигация ----------

document.getElementById('home').addEventListener('click', async () => {
  const session = hostSession.get();
  if (session?.draft) {
    const confirmed = await confirmDialog({
      title: 'Выйти без сохранения?',
      message: 'Эта игра ещё не сохранена. Чтобы запустить её снова позже, нажмите «Сохранить игру».',
      confirmText: 'Выйти',
      cancelText: 'Остаться',
      danger: true,
    });
    if (!confirmed) return;
  }
  await closeRoom(socket);
  location.href = 'index.html';
});

document.getElementById('replay').addEventListener('click', async () => {
  const session = hostSession.get();
  await closeRoom(socket);
  launchGame(session?.draft ? { quizId: session.quizId, quiz: session.draft } : { quizId: session?.quizId });
});

// ---------- Конфетти ----------

function launchConfetti() {
  if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
  const canvas = document.getElementById('confetti');
  const context = canvas.getContext('2d');
  const colors = ['#ff4d6d', '#2f8cff', '#f2a516', '#14b885', '#ffffff', '#ff6a3d'];
  const resize = () => {
    canvas.width = window.innerWidth * devicePixelRatio;
    canvas.height = window.innerHeight * devicePixelRatio;
  };
  resize();
  window.addEventListener('resize', resize);

  const pieces = Array.from({ length: 160 }, () => ({
    x: Math.random() * canvas.width,
    y: -Math.random() * canvas.height * 0.6,
    size: (6 + Math.random() * 8) * devicePixelRatio,
    speed: (2 + Math.random() * 3.5) * devicePixelRatio,
    drift: (Math.random() - 0.5) * 1.6 * devicePixelRatio,
    angle: Math.random() * Math.PI,
    spin: (Math.random() - 0.5) * 0.25,
    color: colors[Math.floor(Math.random() * colors.length)],
  }));

  const startedAt = performance.now();
  const frame = (now) => {
    context.clearRect(0, 0, canvas.width, canvas.height);
    const fading = now - startedAt > 4500;
    let alive = 0;
    for (const piece of pieces) {
      piece.y += piece.speed;
      piece.x += piece.drift + Math.sin((now / 500) + piece.angle);
      piece.angle += piece.spin;
      if (piece.y > canvas.height) {
        if (fading) continue;
        piece.y = -piece.size;
      }
      alive += 1;
      context.save();
      context.translate(piece.x, piece.y);
      context.rotate(piece.angle);
      context.fillStyle = piece.color;
      context.fillRect(-piece.size / 2, -piece.size / 4, piece.size, piece.size / 2);
      context.restore();
    }
    if (alive > 0) requestAnimationFrame(frame);
    else context.clearRect(0, 0, canvas.width, canvas.height);
  };
  requestAnimationFrame(frame);
}

// ---------- Подключение ----------

socket = await openHostRoom({
  page: 'results.html',
  onReady(snapshot) {
    const playersById = new Map(snapshot.players.map((player) => [player.id, player]));
    render(snapshot.final, playersById);
    updateSaveButton();
  },
});
