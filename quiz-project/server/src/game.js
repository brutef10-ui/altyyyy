// Игровой процесс одной комнаты: lobby → question → results → … → final.
// Таймер, приём ответов и подсчёт очков выполняются только здесь.
// Game ничего не знает о Socket.IO: события уходят через объект notify.
import { AppError } from './errors.js';
import { calculatePoints, rankPlayers } from './scoring.js';
import { validateAnswerIndex } from './validate.js';

export const STATES = Object.freeze({
  LOBBY: 'lobby',
  QUESTION: 'question',
  RESULTS: 'results',
  FINAL: 'final',
});

const TRANSITIONS = Object.freeze({
  [STATES.LOBBY]: [STATES.QUESTION],
  [STATES.QUESTION]: [STATES.RESULTS],
  [STATES.RESULTS]: [STATES.QUESTION, STATES.FINAL],
  [STATES.FINAL]: [],
});

const LEADERBOARD_SIZE = 5;
const PODIUM_SIZE = 3;

export class Game {
  /**
   * @param {object} options
   * @param {{title: string, questions: Array}} options.quiz
   * @param {import('./players.js').PlayerRegistry} options.players
   * @param {{host: Function, allPlayers: Function, player: Function, finished?: Function}} options.notify
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
    if (!TRANSITIONS[this.state].includes(next)) {
      throw new AppError('Это действие недоступно на текущем этапе игры', { status: 409, code: 'BAD_STATE' });
    }
    this.state = next;
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
      // Ведущий может закрыть вопрос досрочно.
      this.#endQuestion('host');
      return;
    }
    if (this.state === STATES.RESULTS) {
      if (this.questionIndex + 1 < this.totalQuestions) this.#startQuestion(this.questionIndex + 1);
      else this.#finish();
      return;
    }
    throw new AppError('Это действие недоступно на текущем этапе игры', { status: 409, code: 'BAD_STATE' });
  }

  // ---------- Ответы игроков ----------

  submitAnswer(playerId, { questionIndex, answer }) {
    const player = this.players.get(playerId);
    if (!player) throw new AppError('Вы не участвуете в этой игре', { status: 403, code: 'NOT_A_PLAYER' });

    const tooLate = new AppError('Время на ответ вышло', { status: 409, code: 'TOO_LATE' });
    if (this.state !== STATES.QUESTION || questionIndex !== this.questionIndex) throw tooLate;

    const answeredAt = this.now();
    if (answeredAt > this.round.endsAt) throw tooLate;

    if (this.round.answers.has(playerId)) {
      throw new AppError('Вы уже ответили на этот вопрос', { status: 409, code: 'ALREADY_ANSWERED' });
    }

    const question = this.currentQuestion;
    const checked = validateAnswerIndex(answer, question.answers.length);
    if (!checked.ok) throw new AppError(checked.error, { code: 'BAD_ANSWER' });

    const elapsedMs = Math.max(0, answeredAt - this.round.startedAt);
    const correct = answer === question.correct;
    const points = calculatePoints({ correct, elapsedMs, timeLimitMs: this.round.durationMs });
    this.round.answers.set(playerId, { answer, elapsedMs, correct, points });

    this.notify.host('question:progress', this.#progress());
    if (this.#everyoneAnswered()) this.#endQuestion('all-answered');
    return { questionIndex: this.questionIndex };
  }

  // Вызывается, когда игрок вышел, отключился или был удалён: возможно, ждать больше некого.
  handlePlayersChanged() {
    if (this.state !== STATES.QUESTION) return;
    this.notify.host('question:progress', this.#progress());
    if (this.#everyoneAnswered()) this.#endQuestion('all-answered');
  }

  // ---------- Внутренняя логика ----------

  #startQuestion(index) {
    this.#moveTo(STATES.QUESTION);
    this.questionIndex = index;
    const question = this.currentQuestion;
    const startedAt = this.now();
    const durationMs = question.timeLimit * 1000;
    this.round = { index, startedAt, durationMs, endsAt: startedAt + durationMs, answers: new Map() };
    this.lastResults = null;

    this.timers.clearTimeout(this.timer);
    this.timer = this.timers.setTimeout(() => this.#endQuestion('timeout'), durationMs);

    this.notify.host('question', this.#hostQuestion());
    this.notify.allPlayers('question', this.#playerQuestion());
  }

  #endQuestion(reason) {
    if (this.state !== STATES.QUESTION) return;
    this.timers.clearTimeout(this.timer);
    this.timer = null;
    this.#moveTo(STATES.RESULTS);

    const question = this.currentQuestion;
    const counts = new Array(question.answers.length).fill(0);
    for (const player of this.players.list()) {
      const entry = this.round.answers.get(player.id);
      player.lastPoints = entry ? entry.points : 0;
      if (entry) {
        counts[entry.answer] += 1;
        if (entry.correct) player.correctCount += 1;
      }
      player.score += player.lastPoints;
    }

    const ranking = rankPlayers(this.players.list());
    this.lastResults = {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      correctIndex: question.correct,
      counts,
      answeredCount: counts.reduce((sum, count) => sum + count, 0),
      playerCount: this.players.size,
      isLast: this.questionIndex === this.totalQuestions - 1,
      reason,
      leaderboard: ranking.slice(0, LEADERBOARD_SIZE).map(({ player, rank }) => ({
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
    this.finishedAt = this.now();
    const ranking = rankPlayers(this.players.list());
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
    };

    this.notify.host('game:end', this.finalResults);
    for (const { player, rank } of ranking) {
      this.notify.player(player, 'game:end', this.#playerFinal(player, rank));
    }
    this.notify.finished?.();
  }

  #everyoneAnswered() {
    const active = this.players.connected();
    return active.length > 0 && active.every((player) => this.round.answers.has(player.id));
  }

  #progress() {
    return {
      index: this.questionIndex,
      answered: this.round.answers.size,
      playerCount: this.players.size,
      connectedCount: this.players.connected().length,
    };
  }

  #remainingMs() {
    if (this.state !== STATES.QUESTION) return 0;
    return Math.max(0, this.round.endsAt - this.now());
  }

  #hostQuestion() {
    const question = this.currentQuestion;
    return {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      text: question.text,
      answers: question.answers,
      timeLimit: question.timeLimit,
      remainingMs: this.#remainingMs(),
      ...this.#progress(),
    };
  }

  // Игроку не отправляем номер правильного ответа до окончания вопроса.
  #playerQuestion() {
    const question = this.currentQuestion;
    return {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      text: question.text,
      answers: question.answers,
      timeLimit: question.timeLimit,
      remainingMs: this.#remainingMs(),
    };
  }

  #rankOf(player) {
    return rankPlayers(this.players.list()).find((entry) => entry.player.id === player.id)?.rank ?? null;
  }

  #playerResult(player, rank = this.#rankOf(player)) {
    const entry = this.round?.answers.get(player.id);
    return {
      index: this.questionIndex,
      totalQuestions: this.totalQuestions,
      answered: Boolean(entry),
      answer: entry ? entry.answer : null,
      correct: Boolean(entry?.correct),
      correctIndex: this.currentQuestion.correct,
      correctText: this.currentQuestion.answers[this.currentQuestion.correct],
      points: player.lastPoints,
      score: player.score,
      rank,
      playerCount: this.players.size,
      isLast: this.questionIndex === this.totalQuestions - 1,
    };
  }

  #playerFinal(player, rank = this.#rankOf(player)) {
    return {
      rank,
      score: player.score,
      correctCount: player.correctCount,
      totalQuestions: this.totalQuestions,
      playerCount: this.players.size,
      podium: (this.finalResults?.leaderboard ?? []).slice(0, PODIUM_SIZE).map(({ nickname, score, rank: place }) => ({ nickname, score, rank: place })),
    };
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
    if (this.state === STATES.FINAL) snapshot.final = this.finalResults;
    return snapshot;
  }

  playerSnapshot(player) {
    const snapshot = {
      state: this.state,
      title: this.quiz.title,
      totalQuestions: this.totalQuestions,
      playerCount: this.players.size,
      score: player.score,
    };
    if (this.state === STATES.QUESTION) {
      snapshot.question = this.#playerQuestion();
      const entry = this.round.answers.get(player.id);
      snapshot.myAnswer = entry ? entry.answer : null;
    }
    if (this.state === STATES.RESULTS) snapshot.result = this.#playerResult(player);
    if (this.state === STATES.FINAL) snapshot.final = this.#playerFinal(player);
    return snapshot;
  }

  dispose() {
    this.timers.clearTimeout(this.timer);
    this.timer = null;
  }
}

