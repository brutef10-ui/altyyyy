-- Этап 2: посетители, аккаунты, сессии, сохранённые игры и картинки.
-- Все связи — по неизменяемым UUID, не по логинам. Время — timestamptz, IP — inet.

-- Посетитель (устройство/браузер): токен лежит в HttpOnly cookie, в БД — только его HMAC.
CREATE TABLE visitors (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  first_seen_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_ip inet,
  last_user_agent text
);
CREATE INDEX visitors_last_seen_idx ON visitors (last_seen_at DESC);

-- Аккаунт создателя игр. Роль admin выдаёт только сервер (из переменных окружения).
CREATE TABLE accounts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  login text NOT NULL,
  login_normalized text NOT NULL UNIQUE,
  password_hash text NOT NULL,
  role text NOT NULL DEFAULT 'user' CHECK (role IN ('user', 'admin')),
  created_at timestamptz NOT NULL DEFAULT now(),
  password_changed_at timestamptz NOT NULL DEFAULT now(),
  last_login_at timestamptz,
  backup_code_hash bytea,
  backup_code_created_at timestamptz
);
CREATE INDEX accounts_created_idx ON accounts (created_at DESC);

-- Какие устройства каким аккаунтам принадлежали (многие ко многим, без склеивания аккаунтов).
CREATE TABLE visitor_accounts (
  visitor_id uuid NOT NULL REFERENCES visitors (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  linked_at timestamptz NOT NULL DEFAULT now(),
  last_used_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (visitor_id, account_id)
);
CREATE INDEX visitor_accounts_account_idx ON visitor_accounts (account_id);

-- Серверные сессии. В cookie — случайный токен, в БД — его HMAC.
CREATE TABLE sessions (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash bytea NOT NULL UNIQUE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  visitor_id uuid REFERENCES visitors (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  absolute_expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoke_reason text,
  ip inet,
  user_agent text
);
CREATE INDEX sessions_account_active_idx ON sessions (account_id) WHERE revoked_at IS NULL;
CREATE INDEX sessions_expires_idx ON sessions (expires_at);

-- Сохранённые игры создателей.
CREATE TABLE quizzes (
  id uuid PRIMARY KEY,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  title text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX quizzes_account_idx ON quizzes (account_id, updated_at DESC);

-- Картинки к вопросам (раньше лежали файлами на временном диске).
CREATE TABLE images (
  id text PRIMARY KEY,
  account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
  legacy_owner text,
  content_type text NOT NULL,
  bytes bytea NOT NULL,
  size integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX images_account_idx ON images (account_id);
CREATE INDEX images_created_idx ON images (created_at);

-- Игры из старого quizzes.json (владелец — хэш токена устройства). Переносятся в аккаунт
-- только по самому токену устройства — кнопкой «Забрать игры с этого устройства».
CREATE TABLE legacy_quizzes (
  id uuid PRIMARY KEY,
  device_owner text NOT NULL,
  title text NOT NULL,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  imported_at timestamptz NOT NULL DEFAULT now(),
  claimed_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  claimed_at timestamptz
);
CREATE INDEX legacy_quizzes_owner_idx ON legacy_quizzes (device_owner) WHERE claimed_at IS NULL;

-- Счётчики неудачных попыток (вход, регистрация, восстановление) — переживают перезапуск.
CREATE TABLE auth_throttle (
  key text PRIMARY KEY,
  failures integer NOT NULL DEFAULT 0,
  window_started_at timestamptz NOT NULL DEFAULT now(),
  blocked_until timestamptz
);

-- Настройки сайта, которые меняет админ (например, подсказки о шаринге).
CREATE TABLE settings (
  key text PRIMARY KEY,
  value jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid REFERENCES accounts (id) ON DELETE SET NULL
);
