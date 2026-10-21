# AL Studio — протокол клиент ↔ сервер (версия 2)

Справочник для разработки сайтов. Сервер — единственный источник правды: таймеры, приём ответов,
очки и места считает только он. Клиенты лишь показывают то, что пришло.

## Вход ведущего

Ведущий входит в аккаунт на `host-site/login.html`. Сессия — HttpOnly-cookie, которую сервер ставит сам;
сайт отправляет запросы с `credentials: 'include'`, а Socket.IO — с `withCredentials: true`.

* `GET /api/auth/session` → `{ account: { id, login, role } | null, csrfToken, adminContact }`.
* Изменяющие запросы (`POST`, `PUT`, `DELETE`) несут заголовок `X-CSRF-Token: <csrfToken>`.
  Ошибка `403 { code: 'CSRF' }` — взять токен заново и повторить.
* `401 { code: 'UNAUTHORIZED' }` (REST) или `{ ok: false, code: 'UNAUTHORIZED' }` (`host:create`, `host:resume`) —
  входа нет или сессия отозвана: открыть `login.html?next=<текущая страница>`.
* Восстановление доступа: `POST /api/auth/recover { login, code, newPassword }` → `{ account, backupCode }`
  (новый резервный код показать один раз). Ошибка `401 { code: 'BAD_RECOVERY' }` одна и та же для
  неизвестного логина и неверного кода; `429 { code: 'RATE_LIMIT' }` — слишком много попыток.
* Игрокам вход не нужен: `player:*` и `/api/rooms/*` работают как раньше.

## Блокировки

Если пользователь заблокирован (по аккаунту, устройству или IP), сервер отвечает:

* REST: `403 { code: 'BANNED', error, details: { reason, since, endsAt, forever, contact } }`;
* Socket.IO при подключении: `connect_error`, у ошибки `data = { code: 'BANNED', ban: { reason, endsAt, forever, contact } }`;
* ответ на событие: `{ ok: false, code: 'BANNED', error, ban: { … } }`;
* блокировка во время игры: событие `access:banned { reason, endsAt, forever, contact }`, затем сервер
  отключает сокет. Игрок уже удалён из комнаты; комната заблокированного ведущего закрыта
  (игроки получают `room:closed` с `reason: 'host-banned'`).
* `GET /api/auth/session` → поле `ban` (или `null`).

Сайты показывают экран «Вы заблокированы» (`js/banned.js`); когда срок выходит, страница перезагружается сама.
* Поле `socket.handshake.auth.token` (токен браузера из прежней версии) сервер больше не использует для прав.

## Модель игры

```js
quiz = { title: string /* 1..80 */, questions: Question[] /* 1..50 */ }

Question = {
  type: 'choice' | 'text',     // варианты ответа | ответ вводится вручную
  text: string,                // 1..200, может содержать переносы строк
  image: string | null,        // id картинки (32 hex) или null
  timeLimit: 5|10|15|20|30|45|60|90|120,   // секунд на ответ
  readTime: 0|3|5|8|10|15,     // секунд на чтение вопроса ДО показа вариантов (по умолчанию 5)

  // type === 'choice'
  answers: string[],           // 2..4 варианта, каждый 1..80
  correct: number,             // индекс правильного варианта

  // type === 'text'
  accepted: string[],          // 1..5 правильных вариантов ответа, каждый 1..80
}
```

Старые игры без `type`/`readTime`/`image` читаются как `type: 'choice'`, `readTime: 5`, `image: null`.

Ответ на вопрос типа `text` засчитывается, если после нормализации (регистр, «ё»→«е», знаки
препинания и лишние пробелы не учитываются) он совпадает с одним из `accepted`. Для ответов без
цифр длиной от 5 символов прощается 1 опечатка, от 10 символов — 2.

Ограничения отдаёт `GET /api/config` → `limits` (`timeLimits`, `readTimes`, `defaultReadTime`,
`answersMin/Max`, `acceptedMax`, `answerMax`, `textAnswerMax`, `imageMaxBytes`, …).

## Картинки

* `POST /api/images` — только вошедший ведущий (cookie сессии + заголовок `X-CSRF-Token`). Тело — байты картинки,
  `Content-Type: image/jpeg | image/png | image/webp`, не больше 1 МБ.
  Ответ `201 { id, url }`, где `url = "/api/images/<id>"` (относительно адреса сервера).
  Ошибки: 413 (больше 1 МБ), 415 (не JPEG/PNG/WebP), 409 (превышена квота).
* `GET /api/images/:id` — публично, кэшируется навсегда. Адрес для `<img>`: `${SERVER_URL}/api/images/${id}`.
* Клиент перед загрузкой уменьшает картинку (длинная сторона ≤ 1280 px, JPEG ~0.82).
* Неиспользуемые картинки сервер удаляет сам через 48 часов.

## Ход вопроса

Состояния игры: `lobby → question → results → … → final`. Внутри `question` есть фаза:

1. **`phase: 'reading'`** — показывается только вопрос (текст + картинка). Вариантов нет ни у
   ведущего, ни у игроков. Длится `readTime` секунд. Ответы отклоняются (`TOO_EARLY`).
2. **`phase: 'answering'`** — открываются варианты (или поле ввода), идёт таймер `timeLimit`.

Если `readTime = 0`, вопрос сразу приходит в фазе `answering`.

### Событие `question` (сервер → ведущий и игроки)

Приходит дважды за вопрос: при показе (`reading`) и при открытии вариантов (`answering`).

```js
{
  index, totalQuestions,
  type: 'choice' | 'text',
  text, image /* id | null */,
  timeLimit, readTime,
  phase: 'reading' | 'answering',
  readRemainingMs,      // только в reading: сколько осталось до открытия вариантов
  remainingMs,          // только в answering: сколько осталось на ответ
  answers,              // только в answering и только для choice
  maxLength,            // только для text: 80
  // только ведущему:
  answered, playerCount, connectedCount,
}
```

### Команды

* `player:answer { questionIndex, answer }` — `answer`: номер варианта (choice) или строка 1..80
  символов (text). Ошибки: `TOO_EARLY`, `TOO_LATE`, `ALREADY_ANSWERED`, `BAD_ANSWER`.
* `host:next`:
  * в фазе `reading` — сразу открыть варианты (пропустить чтение);
  * в фазе `answering` — закрыть вопрос досрочно;
  * в `results` — следующий вопрос или финал.

### Событие `results`

Ведущему:

```js
{
  index, totalQuestions, type, isLast, reason,
  answeredCount, playerCount, correctCount, wrongCount, noAnswerCount,
  correctIndex, counts,     // choice: номер верного и сколько выбрали каждый вариант
  accepted,                 // text: правильные ответы
  leaderboard,              // топ-5 [{ id, nickname, score, delta, rank }]; ПУСТОЙ после последнего вопроса
  leaderboardHidden,        // true после последнего вопроса — места раскрываются на церемонии
}
```

Игроку:

```js
{
  index, totalQuestions, type, isLast,
  answered, correct, points,
  answer,                   // свой ответ: номер варианта или текст (null — не ответил)
  correctIndex, correctText,// choice
  accepted,                 // text
  score, rank,              // null после последнего вопроса — чтобы не раскрыть победителей раньше церемонии
  playerCount,
}
```

## Финал и церемония награждения

После `host:next` на последних результатах игра переходит в `final`.

* Ведущий получает `game:end`:
  ```js
  {
    title, totalQuestions, playerCount,
    leaderboard: [{ id, nickname, score, correctCount, rank }], // все игроки
    revealOrder: [3, 2, 1],   // места пьедестала в порядке показа (без пустых; при ничьей мест может быть меньше)
    revealed: 0,              // сколько групп из revealOrder уже показано
  }
  ```
* Игроки получают `game:ceremony { playerCount, totalQuestions }` — экран ожидания
  «Смотрите на экран ведущего». Своё место они пока НЕ знают.
* Ведущий по ходу церемонии отправляет `host:reveal { count? }` — показать следующую группу
  (или довести число показанных групп до `count`). Ответ: `{ revealed, total }`.
  * Игроки с только что показанным местом получают `game:end` с `complete: false`.
  * Когда показаны все группы, **все** игроки получают `game:end` с `complete: true` и `podium`.
  * Если на пьедестале никого (`revealOrder` пуст), `host:reveal` сразу завершает церемонию.
* `game:end` игроку:
  ```js
  { rank, score, correctCount, totalQuestions, playerCount, complete, podium /* [{ nickname, score, rank }] | null */ }
  ```

## Снимки состояния (вход и переподключение)

* `host:resume` / `host:create` → `snapshot`: `{ code, title, state, totalQuestions, questionIndex, players[], question?, results?, final? }`,
  где `question` — последний payload события `question`, `final` — `game:end` + актуальное `revealed`.
* `player:join` / `player:rejoin` → `snapshot`: `{ state, title, totalQuestions, playerCount, score, question?, myAnswer?, result?, final?, ceremony? }`.
  `ceremony: true` — идёт церемония и место игрока ещё не показано.

## Надёжность соединения

* Лимиты по IP считают только **неудачные** попытки (неверный код комнаты): все игроки одной
  Wi-Fi сети спокойно входят одновременно. Возврат в игру по токену (`player:rejoin`) не ограничен по IP.
* Временные ошибки (`TIMEOUT`, `RATE_LIMIT`, `INTERNAL`) клиент не считает фатальными:
  он повторяет попытку с паузой, показывая «Переподключаемся…».
* Отключившийся в лобби игрок остаётся в комнате 10 минут (`PLAYER_RECONNECT_MS`).
