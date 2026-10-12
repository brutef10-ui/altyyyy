// Игровой процесс одной комнаты: lobby → question → results → … → final.
// Внутри вопроса две фазы: reading (только вопрос, время на обдумывание) → answering (варианты и таймер).
// Таймеры, приём ответов, очки и места считаются только здесь.
// Game ничего не знает о Socket.IO: события уходят через объект notify. Протокол — PROTOCOL.md.
import { AppError } from './errors.js';
import { isTextAnswerCorrect } from './answers.js';
import { calculatePoints, rankPlayers } from './scoring.js';
import { validateAnswerIndex, validateTextAnswer } from './validate.js';

export const STATES = Object.freeze({
  LOBBY: 'lobby',
  QUESTION: 'question',
  RESULTS: 'results',
  FINAL: 'final',
});

export const PHASES = Object.freeze({
  READING: 'reading',
  ANSWERING: 'answering',
});

const TRANSITIONS = Object.freeze({
  [STATES.LOBBY]: [STATES.QUESTION],
  [STATES.QUESTION]: [STATES.RESULTS],
  [STATES.RESULTS]: [STATES.QUESTION, STATES.FINAL],
  [STATES.FINAL]: [],
});

const LEADERBOARD_SIZE = 5;
const PODIUM_RANKS = 3;

const badState = () => new AppError('Это действие недоступно на текущем этапе игры', { status: 409, code: 'BAD_STATE' });

export class Game {
  /**
   * @param {object} options
   * @param {{title: string, questions: Array}} options.quiz
   * @param {import('./players.js').PlayerRegistry} options.players
   * @param {{host: Function, allPlayers: Function, player: Function}} options.notify
   */
  constructor({ quiz, players, notify, now = Date.now, timers = { setTimeout, clearTimeout } }) {
    this.quiz = quiz;
    this.players = players;
    this.notify = notify;
    this.now = now;
    this.timers = timers;

    this.state = STATES.LOBBY;
    this.questionIndex = -1;
    this.round = null;
    this.lastResults = null;
    this.finalResults = null;
    this.ceremony = null; // { order: [3, 2, 1], revealed: 0, ranks: Map<playerId, rank> }
    this.finishedAt = null;
    this.timer = null;
  }

  get totalQuestions() {
    return this.quiz.questions.length;
  }

  get isLobby() {
    return this.state === STATES.LOBBY;
  }

  get currentQuestion() {
    return this.quiz.questions[this.questionIndex] ?? null;
  }

  #moveTo(next) {
    if (!TRANSITIONS[this.state].includes(next)) throw badState();
    this.state = next;
  }

  #setTimer(callback, ms) {
    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(callback, ms);
  }

  #clearTimer() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }

  // ---------- Команды ведущего ----------

  start() {
    if (this.state !== STATES.LOBBY) throw new AppError('Игра уже запущена', { status: 409, code: 'BAD_STATE' });
    if (this.players.size === 0) throw new AppError('Нужен хотя бы один игрок, чтобы начать', { status: 409, code: 'NO_PLAYERS' });

    const payload = { title: this.quiz.title, totalQuestions: this.totalQuestions, playerCount: this.players.size };
    this.notify.host('game:started', payload);
    this.notify.allPlayers('game:started', payload);
    this.#startQuestion(0);
  }

  next() {
    if (this.state === STATES.QUESTION) {
      // Во время чтения — сразу открыть варианты, во время ответов — закрыть вопрос досрочно.
      if (this.round.phase === PHASES.READING) this.#openAnswers();
      else this.#endQuestion('host');
      return;
    }
    if (this.state === STATES.RESULTS) {
      if (this.questionIndex + 1 < this.totalQuestions) this.#startQuestion(this.questionIndex + 1);
      else this.#finish();
      return;
    }
    throw badState();
  }

  /**
   * Церемония награждения: показать следующую группу мест пьедестала (или довести число показанных до count).
   * Игроки узнают своё место только в момент показа на экране ведущего.
   */
  reveal(count) {
    if (this.state !== STATES.FINAL) throw badState();
    const { order } = this.ceremony;
    const target = Number.isInteger(count) ? Math.min(order.length, Math.max(count, this.ceremony.revealed)) : Math.min(order.length, this.ceremony.revealed + 1);

    while (this.ceremony.revealed < target) {
      const rank = order[this.ceremony.revealed];
      this.ceremony.revealed += 1;
      for (const player of this.players.list()) {
        if (this.ceremony.ranks.get(player.id) === rank) this.notify.player(player, 'game:end', this.#playerFinal(player));
      }
    }

    if (this.ceremony.revealed >= order.length && !this.ceremony.complete) {
      this.ceremony.complete = true;
      for (const player of this.players.list()) this.notify.player(player, 'game:end', this.#playerFinal(player));
    }
    return { revealed: this.ceremony.revealed, total: order.length };
  }

  // ---------- Ответы игроков ----------

  submitAnswer(playerId, { questionIndex, answer }) {
    const player = this.players.get(playerId);
    if (!player) throw new AppError('Вы не участвуете в этой игре', { status: 403, code: 'NOT_A_PLAYER' });

    const tooLate = new AppError('Время на ответ вышло', { status: 409, code: 'TOO_LATE' });
    if (this.state !== STATES.QUESTION || questionIndex !== this.questionIndex) throw tooLate;
    if (this.round.phase !== PHASES.ANSWERING) {
      throw new AppError('Подождите — варианты ответа ещё не открыты', { status: 409, code: 'TOO_EARLY' });
    }

    const answeredAt = this.now();
    if (answeredAt > this.round.endsAt) throw tooLate;
    if (this.round.answers.has(playerId)) {
      throw new AppError('Вы уже ответили на этот вопрос', { status: 409, code: 'ALREADY_ANSWERED' });
    }

    const question = this.currentQuestion;
    let value;
    let correct;
    if (question.type === 'text') {
      const checked = validateTextAnswer(answer);
      if (!checked.ok) throw new AppError(checked.error, { code: 'BAD_ANSWER' });
      value = checked.value;
      correct = isTextAnswerCorrect(value, question.accepted);
    } else {
      const checked = validateAnswerIndex(answer, question.answers.length);
      if (!checked.ok) throw new AppError(checked.error, { code: 'BAD_ANSWER' });
      value = checked.value;
      correct = value === question.correct;
    }

    const elapsedMs = Math.max(0, answeredAt - this.round.startedAt);
    const points = calculatePoints({ correct, elapsedMs, timeLimitMs: this.round.durationMs });
    this.round.answers.set(playerId, { answer: value, elapsedMs, correct, points });

    this.notify.host('question:progress', this.#progress());
    if (this.#everyoneAnswered()) this.#endQuestion('all-answered');
    return { questionIndex: this.questionIndex };
  }

  // Вызывается, когда игрок вышел, отключился, вернулся или был удалён: возможно, ждать больше некого.
  handlePlayersChanged() {
    if (this.state !== STATES.QUESTION) return;
    this.notify.host('question:progress', this.#progress());
    if (this.round.phase === PHASES.ANSWERING && this.#everyoneAnswered()) this.#endQuestion('all-answered');
  }

  // ---------- Ход вопроса ----------

  #startQuestion(index) {
    this.#moveTo(STATES.QUESTION);
    this.questionIndex = index;
    this.lastResults = null;
    const question = this.currentQuestion;
    const readMs = (question.readTime ?? 0) * 1000;
    const durationMs = question.timeLimit * 1000;
    this.round = { index, phase: PHASES.READING, readEndsAt: this.now() + readMs, startedAt: null, endsAt: null, durationMs, answers: new Map() };

    if (readMs > 0) {
      this.#setTimer(() => this.#openAnswers(), readMs);
      this.#broadcastQuestion();
    } else {
      this.#openAnswers();
    }
  }

  #openAnswers() {
    if (this.state !== STATES.QUESTION || this.round.phase !== PHASES.READING) return;
    const startedAt = this.now();
    Object.assign(this.round, { phase: PHASES.ANSWERING, startedAt, endsAt: startedAt + this.round.durationMs });
    this.#setTimer(() => this.#endQuestion('timeout'), this.round.durationMs);
    this.#broadcastQuestion();
  }

  #broadcastQuestion() {
    this.notify.host('question', this.#hostQuestion());
    this.notify.allPlayers('question', this.#playerQuestion());
  }

  #endQuestion(reason) {
    if (this.state !== STATES.QUESTION) return;
    this.#clearTimer();
    this.#moveTo(STATES.RESULTS);

    const question = this.currentQuestion;
    const isLast = this.questionIndex === this.totalQuestions - 1;
    const counts = question.type === 'choice' ? new Array(question.answers.length).fill(0) : null;
    let correctCount = 0;
    let answeredCount = 0;
    for (const player of this.players.list()) {
      const entry = this.round.answers.get(player.id);
      player.lastPoints = entry ? entry.points : 0;
      if (entry) {
        answeredCount += 1;
        if (counts) counts[entry.answer] += 1;
        if (entry.correct) {
          correctCount += 1;
          player.correctCount += 1;
        }
      }
      player.score += player.lastPoints;
    }

    const ranking = rankPlayers(this.players.list());
    this.lastResults = {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      type: question.type,
      isLast,
      reason,
      answeredCount,
      playerCount: this.players.size,
      correctCount,
      wrongCount: answeredCount - correctCount,
      noAnswerCount: this.players.size - answeredCount,
      ...(question.type === 'choice' ? { correctIndex: question.correct, counts } : { accepted: question.accepted }),
      // После последнего вопроса места не показываем: их раскроет церемония награждения.
      leaderboardHidden: isLast,
      leaderboard: isLast ? [] : ranking.slice(0, LEADERBOARD_SIZE).map(({ player, rank }) => ({
        id: player.id,
        nickname: player.nickname,
        score: player.score,
        delta: player.lastPoints,
        rank,
      })),
    };

    this.notify.host('results', this.lastResults);
    const ranks = new Map(ranking.map(({ player, rank }) => [player.id, rank]));
    for (const player of this.players.list()) {
      this.notify.player(player, 'results', this.#playerResult(player, ranks.get(player.id)));
    }
  }

  #finish() {
    this.#moveTo(STATES.FINAL);
    this.#clearTimer();
    this.finishedAt = this.now();
    const ranking = rankPlayers(this.players.list());
    const podiumRanks = [...new Set(ranking.map(({ rank }) => rank).filter((rank) => rank <= PODIUM_RANKS))];

    this.ceremony = {
      order: podiumRanks.sort((a, b) => b - a), // от третьего места к первому
      revealed: 0,
      complete: false,
      ranks: new Map(ranking.map(({ player, rank }) => [player.id, rank])),
    };
    this.finalResults = {
      title: this.quiz.title,
      totalQuestions: this.totalQuestions,
      playerCount: this.players.size,
      leaderboard: ranking.map(({ player, rank }) => ({
        id: player.id,
        nickname: player.nickname,
        score: player.score,
        correctCount: player.correctCount,
        rank,
      })),
      revealOrder: this.ceremony.order,
    };

    this.notify.host('game:end', this.#hostFinal());
    this.notify.allPlayers('game:ceremony', { playerCount: this.players.size, totalQuestions: this.totalQuestions });
    if (this.ceremony.order.length === 0) this.reveal();
  }

  #everyoneAnswered() {
    const active = this.players.connected();
    return active.length > 0 && active.every((player) => this.round.answers.has(player.id));
  }

  // ---------- Данные для клиентов ----------

  #progress() {
    return {
      index: this.questionIndex,
      answered: this.round.answers.size,
      playerCount: this.players.size,
      connectedCount: this.players.connected().length,
    };
  }

  // Общая часть вопроса. Варианты ответа уходят только после фазы чтения.
  #questionPayload() {
    const question = this.currentQuestion;
    const round = this.round;
    const payload = {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      type: question.type,
      text: question.text,
      image: question.image ?? null,
      timeLimit: question.timeLimit,
      readTime: question.readTime ?? 0,
      phase: round.phase,
    };
    if (question.type === 'text') payload.maxLength = 80;

    const live = this.state === STATES.QUESTION;
    if (round.phase === PHASES.READING) {
      payload.readRemainingMs = live ? Math.max(0, round.readEndsAt - this.now()) : 0;
    } else {
      payload.remainingMs = live ? Math.max(0, round.endsAt - this.now()) : 0;
      if (question.type === 'choice') payload.answers = question.answers;
    }
    return payload;
  }

  #hostQuestion() {
    return { ...this.#questionPayload(), ...this.#progress() };
  }

  // Игроку не отправляем правильный ответ до окончания вопроса.
  #playerQuestion() {
    return this.#questionPayload();
  }

  #rankOf(player) {
    return rankPlayers(this.players.list()).find((entry) => entry.player.id === player.id)?.rank ?? null;
  }

  #playerResult(player, rank = this.#rankOf(player)) {
    const question = this.currentQuestion;
    const entry = this.round?.answers.get(player.id);
    const isLast = this.questionIndex === this.totalQuestions - 1;
    return {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      type: question.type,
      isLast,
      answered: Boolean(entry),
      answer: entry ? entry.answer : null,
      correct: Boolean(entry?.correct),
      points: player.lastPoints,
      ...(question.type === 'choice'
        ? { correctIndex: question.correct, correctText: question.answers[question.correct] }
        : { accepted: question.accepted }),
      // После последнего вопроса счёт и место скрыты до церемонии награждения.
      score: isLast ? null : player.score,
      rank: isLast ? null : rank,
      playerCount: this.players.size,
    };
  }

  #isRevealedFor(player) {
    if (!this.ceremony) return false;
    if (this.ceremony.complete) return true;
    const rank = this.ceremony.ranks.get(player.id);
    return this.ceremony.order.slice(0, this.ceremony.revealed).includes(rank);
  }

  #playerFinal(player) {
    const complete = Boolean(this.ceremony?.complete);
    return {
      rank: this.ceremony?.ranks.get(player.id) ?? this.#rankOf(player),
      score: player.score,
      correctCount: player.correctCount,
      totalQuestions: this.totalQuestions,
      playerCount: this.players.size,
      complete,
      podium: complete
        ? this.finalResults.leaderboard.filter(({ rank }) => rank <= PODIUM_RANKS).map(({ nickname, score, rank }) => ({ nickname, score, rank }))
        : null,
    };
  }

  #hostFinal() {
    return { ...this.finalResults, revealed: this.ceremony.revealed };
  }

  // ---------- Снимки состояния (для переподключения) ----------

  hostSnapshot() {
    const snapshot = {
      state: this.state,
      title: this.quiz.title,
      totalQuestions: this.totalQuestions,
      questionIndex: this.questionIndex,
    };
    if (this.state === STATES.QUESTION || this.state === STATES.RESULTS) snapshot.question = this.#hostQuestion();
    if (this.state === STATES.RESULTS) snapshot.results = this.lastResults;
    if (this.state === STATES.FINAL) snapshot.final = this.#hostFinal();
    return snapshot;
  }

  playerSnapshot(player) {
    const snapshot = {
      state: this.state,
      title: this.quiz.title,
      totalQuestions: this.totalQuestions,
      playerCount: this.players.size,
      // В финале до показа места счёт скрыт, как и после последнего вопроса.
      score: this.state === STATES.FINAL && !this.#isRevealedFor(player) ? null : player.score,
    };
    if (this.state === STATES.QUESTION) {
      snapshot.question = this.#playerQuestion();
      const entry = this.round.answers.get(player.id);
      snapshot.myAnswer = entry ? entry.answer : null;
    }
    if (this.state === STATES.RESULTS) {
      snapshot.result = this.#playerResult(player);
      if (snapshot.result.isLast) snapshot.score = null;
    }
    if (this.state === STATES.FINAL) {
      if (this.#isRevealedFor(player)) snapshot.final = this.#playerFinal(player);
      else snapshot.ceremony = true;
    }
    return snapshot;
  }

  dispose() {
    this.#clearTimer();
  }
}
