# AL Studio — квиз-игра в реальном времени

Ведущий выводит вопросы на большой экран, игроки отвечают с телефонов. Проект состоит из трёх независимых частей:

| Часть | Что делает | Порт по умолчанию |
|---|---|---|
| `server/` | Node.js + Express + Socket.IO. Вся игровая логика, таймер и подсчёт очков, REST API для сохранённых игр | 3000 |
| `host-site/` | Сайт ведущего: список игр, редактор, лобби, экран игры, итоги | 5500 |
| `player-site/` | Сайт игрока: код комнаты → селфи → ник → игра | 5501 |

Сайты ничего не знают друг о друге и общаются только с сервером. Клиентам сервер не доверяет: правильные ответы, время и очки знает только он.

```
quiz-project/
├── server/
│   ├── server.js            # Express + Socket.IO + CORS, REST API
│   ├── src/
│   │   ├── config.js        # настройки из .env
│   │   ├── auth.js          # владелец игр (токен браузера; сюда добавляется логин)
│   │   ├── rooms.js         # комнаты, уникальный 6-значный код
│   │   ├── game.js          # состояния lobby → question → results → final, таймер
│   │   ├── scoring.js       # очки: правильность + скорость, рейтинг
│   │   ├── players.js       # игроки: ник, аватар, очки
│   │   ├── quizzes.js       # сохранённые игры (CRUD) + хранилище JSON
│   │   ├── validate.js      # проверка кода, ника, фото, ответа, игры
│   │   ├── sockets.js       # события Socket.IO
│   │   ├── rateLimit.js     # ограничение частоты запросов
│   │   └── errors.js
│   ├── data/quizzes.json
│   ├── test/                # node:test — unit и интеграционные тесты
│   └── .env.example
├── host-site/
│   ├── index.html  editor.html  lobby.html  game.html  results.html
│   ├── css/style.css
│   └── js/ config.js api.js session.js socket.js ui.js home.js editor.js lobby.js game.js results.js
├── player-site/
│   ├── index.html  photo.html  name.html  play.html
│   ├── css/style.css
│   └── js/ config.js session.js socket.js ui.js join.js camera.js play.js
└── tools/
    ├── serve.js             # мини-сервер статики без зависимостей
    ├── dev.js               # запуск всех трёх частей одной командой
    └── single.js            # запуск одним процессом (сервер отдаёт оба сайта)

render.yaml                  # (в корне репозитория) деплой на Render одним сервисом
```

## Установка и запуск

Нужен **Node.js 18.18+** (рекомендуется 20 или 22).

### Всё одной командой

```bash
cd quiz-project
npm install          # установит зависимости сервера
npm run dev          # сервер :3000, сайт ведущего :5500, сайт игрока :5501
```

Откройте http://localhost:5500 — это экран ведущего. Игроки заходят на http://localhost:5501.

### По отдельности (три терминала)

```bash
# 1. Сервер
cd quiz-project/server
cp .env.example .env     # при необходимости поправьте адреса
npm install
npm start                # или npm run dev — с перезапуском при изменениях

# 2. Сайт ведущего
cd quiz-project
node tools/serve.js host-site 5500

# 3. Сайт игрока
cd quiz-project
node tools/serve.js player-site 5501
```

Сайты — обычная статика: вместо `tools/serve.js` подойдёт любой веб-сервер (`npx serve`, nginx, Live Server в VS Code). Открывать HTML-файлы напрямую через `file://` нельзя — нужны ES-модули и HTTP.

### Одним процессом (режим `SERVE_SITES`)

```bash
cd quiz-project
npm install
npm run single
```

Сервер сам отдаёт оба сайта на одном порту: сайт игрока — http://localhost:3000/, сайт ведущего — http://localhost:3000/host/. CORS настраивать не нужно. Этот же режим используется для деплоя одним сервисом (`render.yaml`) и для запуска на телефоне.

### На Android-телефоне (Termux)

1. Установите **Termux** из F-Droid (https://f-droid.org/packages/com.termux/) — версия в Google Play устарела.
2. В Termux:
   ```bash
   pkg update -y && pkg install -y nodejs-lts git
   git clone -b claude/interactive-quiz-game-o8s0kx https://github.com/brutef10-ui/altyyyy
   cd altyyyy/quiz-project
   npm install
   npm run single
   ```
3. В Chrome откройте http://localhost:3000/host/ — экран ведущего, а в новой вкладке http://localhost:3000/ — экран игрока. На `localhost` камера работает.
4. Не закрывайте Termux. Чтобы Android не остановил сервер в фоне, в шторке уведомлений Termux нажмите «Acquire wakelock». Остановить сервер — `Ctrl` + `C` (кнопка CTRL на панели Termux, затем C).

Чтобы друзья в той же Wi-Fi сети играли со своих телефонов, узнайте IP телефона (Настройки → Wi-Fi → ваша сеть, например `192.168.1.5`) и запустите так:

```bash
PLAYER_SITE_URL=http://192.168.1.5:3000 npm run single
```

Игроки открывают `http://192.168.1.5:3000`. По обычному `http://` браузер не включит камеру на странице, поэтому у них будет кнопка «Загрузить фото» — на телефоне она откроет фронтальную камеру. Для селфи прямо на странице нужен HTTPS — см. деплой на Render.

Обновить код до последней версии: `cd altyyyy && git pull`, затем снова `cd quiz-project && npm install && npm run single`.

### Настройка `.env`

| Переменная | Назначение | По умолчанию |
|---|---|---|
| `PORT` | порт сервера | `3000` |
| `HOST_SITE_ORIGIN` | адрес сайта ведущего (CORS). Несколько — через запятую | `http://localhost:5500,http://127.0.0.1:5500` |
| `PLAYER_SITE_ORIGIN` | адрес сайта игрока (CORS). Несколько — через запятую | `http://localhost:5501,http://127.0.0.1:5501` |
| `PLAYER_SITE_URL` | публичный адрес сайта игрока, его видно в лобби и в QR-коде | первый из `PLAYER_SITE_ORIGIN` |
| `SERVE_SITES` | `true` — сервер сам отдаёт оба сайта (`/` и `/host/`) | `false` |
| `DATA_FILE` | путь к JSON-файлу с играми | `./data/quizzes.json` |
| `TRUST_PROXY` | `true`, если сервер за прокси (Render, Railway, nginx) | `false` |
| `HOST_RECONNECT_MS` | сколько ждать ведущего после отключения, прежде чем закрыть комнату | `15000` |
| `PLAYER_RECONNECT_MS` | сколько ждать игрока в лобби, прежде чем убрать его из списка | `30000` |
| `MAX_PLAYERS_PER_ROOM`, `MAX_ROOMS` | ограничения | `100`, `500` |

Адрес сервера для сайтов задаётся в `host-site/js/config.js` и `player-site/js/config.js` (константа `PRODUCTION_SERVER_URL`). Если она пустая, сайт ищет сервер на том же хосте на порту 3000 — для локальной работы ничего менять не нужно.

### Камера работает только по HTTPS

Браузеры дают доступ к камере (`getUserMedia`) только в «безопасном контексте»: по **HTTPS** или на **localhost**.

* На компьютере через `http://localhost:5501` камера работает.
* Если открыть сайт игрока с телефона по адресу локальной сети (`http://192.168.x.x:5501`), камеры не будет. Тогда сайт сам предложит запасной вариант — загрузить фото (`<input type="file" capture="user">`): на телефоне он тоже откроет камеру, а фото всё равно обязательно.
* Чтобы проверить настоящее селфи с телефона, откройте сайты через HTTPS-туннель (например, `cloudflared tunnel --url http://localhost:5501` и такой же туннель для сервера) или задеплойте проект (см. ниже). Не забудьте добавить HTTPS-адреса в `HOST_SITE_ORIGIN`/`PLAYER_SITE_ORIGIN` и прописать адрес сервера в `config.js`.

## Как проверить каждую часть

### 1. Сервер

```bash
cd quiz-project/server
npm test                               # 18 тестов: валидация, очки, полный цикл игры через Socket.IO, режим SERVE_SITES
npm start
curl http://localhost:3000/health      # {"status":"ok","rooms":0,...}
curl http://localhost:3000/api/quizzes # 401 — без токена ведущего игры не отдаются
```

Интеграционные тесты поднимают сервер на случайном порту и проверяют: CRUD игр и изоляцию по токену, CORS, создание комнаты, вход игроков (уникальный ник, обязательное и проверенное фото), команды ведущего только от его сокета, один ответ на вопрос, отказ в ответе после таймера, подсчёт очков, финал, закрытие комнаты при уходе ведущего, переподключение ведущего и игрока, удаление игрока.

### 2. Сайт ведущего

1. Откройте http://localhost:5500 → «Открыть демо» (или «Создать новую»).
2. В редакторе попробуйте очистить название и нажать «Запустить» — появится список ошибок и подсветка полей.
3. Нажмите «Сохранить» → вернитесь на главную: игра появилась в списке.
4. «▶ Запустить» → откроется лобби с крупным 6-значным кодом. Новый запуск — новый код.

### 3. Сайт игрока

1. Откройте http://localhost:5501 во втором окне (или в режиме телефона в DevTools), введите код из лобби.
2. Сделайте селфи — пока снимка нет, «Продолжить» неактивна. Запретите камеру в настройках сайта — появится понятная ошибка и кнопка загрузки фото.
3. Введите ник — в лобби ведущего игрок появится с аватаром и анимацией. Второй игрок с тем же ником получит ошибку.
4. Ведущий жмёт «Старт» → у игроков появляются 4 цветные кнопки. После ответа или окончания таймера — экран «Верно / Неверно / Время вышло» с очками и местом. Ведущий жмёт «Далее» (или пробел), в конце — пьедестал и кнопка «Сохранить игру».
5. Закройте вкладку ведущего — через `HOST_RECONNECT_MS` игроки увидят «Ведущий отключился».

## Как устроена игра

### Логика ведущего

* Игру создают в редакторе: название, до 50 вопросов, 2–4 варианта, правильный ответ, время (5–120 с).
* Новую игру можно сразу запустить без сохранения, а сохранить после финала кнопкой «Сохранить игру». Сохранённые игры видны списком на главной; каждый запуск создаёт новую комнату с новым кодом.
* Результаты прошлых игр и фото игроков нигде не сохраняются: они живут только в памяти, пока открыта комната.
* Игры привязаны к браузеру ведущего: при первом входе браузер создаёт секретный токен и хранит его в `localStorage`. Сервер хранит только SHA-256 токена.
* Лобби, игра и итоги — отдельные страницы. При переходе страница заново подключается и «забирает» комнату событием `host:resume` с секретным ключом комнаты (`hostKey`). Пока ведущий переходит между страницами, сервер ждёт его `HOST_RECONNECT_MS`; если он не вернулся — комната закрывается, игроки получают уведомление.
* В лобби по клику на игрока его можно удалить (например, за неподходящее фото).

### Логика игрока

1. Код комнаты — сервер проверяет, что комната есть и игра не началась.
2. Селфи — `getUserMedia({ video: { facingMode: "user" } })`, снимок на canvas, центр кадра сжимается до 200×200, JPEG, качество 0.7 (обычно 5–15 КБ). Запасной вариант — загрузка файла.
3. Ник — 2–16 символов: буквы, цифры, пробел, `_ - .`; уникален в комнате без учёта регистра.
4. Всё уходит одним событием `player:join` (код, ник, фото base64).
5. Экран ожидания → кнопки ответа → результат после каждого вопроса → финал. При обрыве связи или перезагрузке страницы игрок возвращается в игру по токену (`player:rejoin`) с сохранёнными очками.

### Очки

Неправильный ответ — 0. Правильный — от 500 до 1000: `1000 × (1 − время_ответа / время_вопроса / 2)`. Время меряет сервер от момента отправки вопроса до получения ответа. Одинаковые очки — одинаковое место.

### События Socket.IO

| Направление | Событие | Данные |
|---|---|---|
| ведущий → сервер | `host:create` | `{ quizId }` или `{ quiz }` → `{ code, hostKey, snapshot }` |
| ведущий → сервер | `host:resume` | `{ code, hostKey }` → `{ snapshot }` |
| ведущий → сервер | `host:start`, `host:next` | — (`host:next` во время вопроса закрывает его досрочно) |
| ведущий → сервер | `host:kick`, `host:close` | `{ playerId }` / — |
| игрок → сервер | `player:join` | `{ code, nickname, photo }` → `{ playerId, token, snapshot }` |
| игрок → сервер | `player:rejoin` | `{ code, token }` → `{ snapshot }` |
| игрок → сервер | `player:answer` | `{ questionIndex, answer }` |
| сервер → клиенты | `lobby:update` | ведущему `{ action: join/update/leave, player, count }`, игрокам `{ count }` |
| сервер → клиенты | `game:started`, `question`, `question:progress`, `results`, `game:end` | ход игры (игроки не получают номер правильного ответа до конца вопроса) |
| сервер → клиенты | `room:closed`, `player:kicked`, `error` | закрытие комнаты, удаление игрока, ошибка без callback |

Каждый запрос клиента получает ответ через acknowledgement: `{ ok: true, ... }` или `{ ok: false, error, code }`.

### REST API

| Метод | Путь | Кто | Описание |
|---|---|---|---|
| GET | `/api/quizzes` | ведущий (`Authorization: Bearer <token>`) | список игр |
| GET | `/api/quizzes/:id` | ведущий | игра целиком |
| POST | `/api/quizzes` | ведущий | создать |
| PUT | `/api/quizzes/:id` | ведущий | изменить |
| DELETE | `/api/quizzes/:id` | ведущий | удалить |
| GET | `/api/rooms/:code` | игрок | можно ли войти в комнату |
| POST | `/api/rooms/:code/nickname` | игрок | свободен ли ник |
| GET | `/api/config` | оба сайта | адрес сайта игрока, лимиты |
| GET | `/health` | — | проверка работоспособности |

### Безопасность и надёжность

* Команды `host:*` принимаются только от сокета, который сейчас управляет комнатой: создавшего её или вернувшегося с `hostKey` **и** тем же токеном ведущего.
* Сервер проверяет всё: код (6 цифр), ник (длина, символы, уникальность), фото (только `data:image/jpeg|png;base64`, до 100 КБ, проверка сигнатуры файла), номер вопроса и ответа, структуру игры.
* Один ответ на вопрос; ответы после окончания таймера отклоняются (`TOO_LATE`).
* CORS: игры (`/api/quizzes`) доступны только сайту ведущего, проверки комнаты — обоим сайтам. Для WebSocket сервер сам проверяет заголовок `Origin`.
* Ограничение частоты: попытки входа и проверки кода с одного IP, создание комнат, любые события сокета.
* Пользовательский текст вставляется в страницу только через `textContent`.
* Ограничен размер сообщений Socket.IO (256 КБ) и JSON-запросов.
* Старые комнаты удаляются автоматически (через 15 минут после финала, любые — через 6 часов).

## Деплой

Есть два варианта: **один сервис** (сервер сам отдаёт оба сайта — проще всего, можно сделать с телефона) или **три сервиса** (сервер и два статических сайта отдельно).

### Render одним сервисом (Blueprint)

В корне репозитория лежит `render.yaml`.

1. Зарегистрируйтесь на https://render.com через GitHub.
2. **New → Blueprint**, выберите репозиторий и ветку с игрой, нажмите **Apply** / **Deploy Blueprint**.
3. Через несколько минут сервис `al-studio` получит адрес вида `https://al-studio-xxxx.onrender.com`:
   * ведущий: `https://al-studio-xxxx.onrender.com/host/`
   * игроки: `https://al-studio-xxxx.onrender.com/` (адрес и QR-код видны в лобби).

Если Blueprint недоступен, создайте **New → Web Service** вручную: репозиторий и ветка с игрой, Root Directory `quiz-project`, Build Command `npm install`, Start Command `npm start`, переменные `SERVE_SITES=true` и `TRUST_PROXY=true`.

Ограничения бесплатного тарифа: сервис засыпает после 15 минут без запросов (первое открытие — до минуты), а файловая система временная — сохранённые игры пропадут после перезапуска или нового деплоя. Чтобы игры сохранялись, подключите Disk (платно) и задайте `DATA_FILE` на него.

### Render тремя сервисами

**Сервер** — New → Web Service:

* Root Directory: `quiz-project/server`
* Build Command: `npm install`
* Start Command: `npm start`
* Environment:
  * `HOST_SITE_ORIGIN=https://al-studio-host.onrender.com`
  * `PLAYER_SITE_ORIGIN=https://al-studio-play.onrender.com`
  * `TRUST_PROXY=true`
  * `DATA_FILE=/var/data/quizzes.json` и подключите **Disk** с путём `/var/data` (диски доступны на платных тарифах). Без диска сохранённые игры пропадут при перезапуске или новом деплое: файловая система Render временная.

**Сайты** — New → Static Site (дважды):

* Root Directory: `quiz-project/host-site` (и `quiz-project/player-site`)
* Publish Directory: `.`
* Build Command (подставит адрес сервера в `config.js`):
  ```bash
  sed -i "s#const PRODUCTION_SERVER_URL = '';#const PRODUCTION_SERVER_URL = '$SERVER_URL';#" js/config.js
  ```
* Environment: `SERVER_URL=https://al-studio-server.onrender.com`

### Railway

1. **Сервер**: New Service → GitHub repo, Root Directory `quiz-project/server`, Start Command `npm start`. Переменные — как для Render (`HOST_SITE_ORIGIN`, `PLAYER_SITE_ORIGIN`, `TRUST_PROXY=true`). Для сохранённых игр добавьте **Volume** (например, `/data`) и `DATA_FILE=/data/quizzes.json`. Включите публичный домен (Settings → Networking → Generate Domain).
2. **Сайт ведущего**: ещё один сервис из того же репозитория, Root Directory `quiz-project`, Start Command `node tools/serve.js host-site`, переменная `SERVER_URL=https://<домен-сервера>`. `tools/serve.js` сам возьмёт `PORT` от Railway и подставит `SERVER_URL` в `config.js`.
3. **Сайт игрока**: то же самое с `node tools/serve.js player-site`.
4. Впишите домены сайтов в `HOST_SITE_ORIGIN` / `PLAYER_SITE_ORIGIN` сервера и перезапустите его.

На бесплатных тарифах сервер «засыпает» без запросов — первое подключение может занять до минуты.

## Как развивать проект

### Переход на SQLite

Всё хранение игр — в классе `JsonQuizStore` (`server/src/quizzes.js`). Достаточно написать класс с теми же методами и передать его в `QuizService` в `server.js`:

```js
// server/src/sqliteStore.js  (npm install better-sqlite3)
import Database from 'better-sqlite3';

export class SqliteQuizStore {
  constructor(file) {
    this.db = new Database(file);
  }
  async init() {
    this.db.exec(`CREATE TABLE IF NOT EXISTS quizzes (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, data TEXT NOT NULL,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL)`);
    this.db.exec('CREATE INDEX IF NOT EXISTS quizzes_owner ON quizzes(owner_id)');
  }
  #row(row) {
    return row && { id: row.id, ownerId: row.owner_id, ...JSON.parse(row.data), createdAt: row.created_at, updatedAt: row.updated_at };
  }
  async listByOwner(ownerId) {
    return this.db.prepare('SELECT * FROM quizzes WHERE owner_id = ?').all(ownerId).map((r) => this.#row(r));
  }
  async findById(id) {
    return this.#row(this.db.prepare('SELECT * FROM quizzes WHERE id = ?').get(id)) ?? null;
  }
  async insert(quiz) {
    const { id, ownerId, createdAt, updatedAt, ...data } = quiz;
    this.db.prepare('INSERT INTO quizzes VALUES (?, ?, ?, ?, ?)').run(id, ownerId, JSON.stringify(data), createdAt, updatedAt);
    return quiz;
  }
  async update(id, changes) {
    const current = await this.findById(id);
    if (!current) return null;
    const { ownerId, createdAt, updatedAt, ...data } = { ...current, ...changes };
    delete data.id;
    this.db.prepare('UPDATE quizzes SET data = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(data), updatedAt, id);
    return { id, ownerId, ...data, createdAt, updatedAt };
  }
  async remove(id) {
    return this.db.prepare('DELETE FROM quizzes WHERE id = ?').run(id).changes > 0;
  }
}
```

В `server.js` замените `new JsonQuizStore(config.dataFile)` на `new SqliteQuizStore(config.dataFile.replace(/\.json$/, '.db'))`.

### Вход по логину

Код сервера работает только с `owner.id` и не знает, как ведущий вошёл. В `server/src/auth.js` добавьте резолвер (cookie-сессия, JWT, OAuth), который возвращает `{ id: 'user:<id>', kind: 'user' }`, и поставьте его первым в `RESOLVERS`. На сайте ведущего вместо `getHostToken()` в `js/api.js` и `js/socket.js` передавайте токен сессии. Чтобы перенести игры с устройства в аккаунт, замените их `ownerId` с `device:…` на `user:…`.

### Новые функции ведущего

Сайт ведущего разбит на модули: `api.js` (REST), `socket.js` (подключение и восстановление комнаты), `session.js` (состояние вкладки), `ui.js` (общие элементы), по одному модулю на страницу. Новое событие добавляется в трёх местах: обработчик в `server/src/sockets.js`, логика в `server/src/game.js` (если касается хода игры), подписка на странице ведущего.
