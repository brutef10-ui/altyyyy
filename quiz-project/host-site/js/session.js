// Состояние ведущего в браузере.
// sessionStorage живёт в пределах вкладки — этого хватает, чтобы пройти лобби → игра → итоги.

function read(storage, key) {
  try {
    return JSON.parse(storage.getItem(key));
  } catch {
    return null;
  }
}

function write(storage, key, value) {
  try {
    if (value === null || value === undefined) storage.removeItem(key);
    else storage.setItem(key, JSON.stringify(value));
  } catch {
    /* хранилище недоступно или переполнено */
  }
}

function slot(storage, key) {
  return {
    get: () => read(storage, key),
    set: (value) => write(storage, key, value),
    clear: () => write(storage, key, null),
  };
}

/**
 * Активная комната: { code, hostKey, title, quizId, draft }.
 * quizId — id сохранённой игры (если есть), draft — несохранённая версия вопросов (если есть).
 */
export const hostSession = {
  ...slot(sessionStorage, 'iskra.host.session'),
  patch(changes) {
    const next = { ...(this.get() || {}), ...changes };
    this.set(next);
    return next;
  },
};

/** Что запустить в лобби: { quizId } — сохранённую игру, { quiz, quizId? } — черновик из редактора. */
export const launchRequest = slot(sessionStorage, 'iskra.host.launch');

/** Автосохранение новой (ещё не сохранённой на сервере) игры в редакторе. */
export const editorDraft = slot(localStorage, 'iskra.editor.draft');

/** Короткое сообщение для следующей страницы. */
const flashSlot = slot(sessionStorage, 'iskra.host.flash');
export const flash = {
  set: (message, type = 'info') => flashSlot.set({ message, type }),
  take() {
    const value = flashSlot.get();
    flashSlot.clear();
    return value;
  },
};
