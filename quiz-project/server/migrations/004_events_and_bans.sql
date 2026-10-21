-- Этап 5: журнал заходов и блокировки.

-- Журнал событий: вход в аккаунт, регистрация, восстановление, вход в комнату по коду,
-- создание игры и запуск комнаты. Пишется всегда (независимо от подсказок о шаринге).
-- Через EVENTS_ANONYMIZE_DAYS IP обрезается до сети (/24 или /48), user-agent удаляется,
-- остальное (типы устройств, связи с посетителем и аккаунтом) сохраняется для подсчётов.
CREATE TABLE events (
  id bigserial PRIMARY KEY,
  type text NOT NULL,
  visitor_id uuid REFERENCES visitors (id) ON DELETE SET NULL,
  account_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
  account_login text,
  nickname text,
  room_code text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  device_type text,
  os text,
  browser text,
  created_at timestamptz NOT NULL DEFAULT now(),
  anonymized_at timestamptz
);
CREATE INDEX events_created_idx ON events (created_at DESC);
CREATE INDEX events_account_idx ON events (account_id, created_at DESC) WHERE account_id IS NOT NULL;
CREATE INDEX events_visitor_idx ON events (visitor_id, created_at DESC) WHERE visitor_id IS NOT NULL;
CREATE INDEX events_ip_idx ON events (ip, created_at DESC);
CREATE INDEX events_type_idx ON events (type, created_at DESC);
CREATE INDEX events_anonymize_idx ON events (created_at) WHERE anonymized_at IS NULL;

-- Блокировки. Цель — аккаунт и/или посетитель (устройство) и/или IP (адрес или узкая подсеть).
-- Снятие не удаляет запись: история хранится BAN_HISTORY_RETENTION_DAYS.
CREATE TABLE bans (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid REFERENCES accounts (id) ON DELETE CASCADE,
  visitor_id uuid REFERENCES visitors (id) ON DELETE CASCADE,
  ip inet,
  reason text NOT NULL,
  starts_at timestamptz NOT NULL DEFAULT now(),
  ends_at timestamptz,
  created_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  created_by_login text,
  created_at timestamptz NOT NULL DEFAULT now(),
  lifted_at timestamptz,
  lifted_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  lifted_by_login text,
  lift_reason text,
  CONSTRAINT bans_target CHECK (account_id IS NOT NULL OR visitor_id IS NOT NULL OR ip IS NOT NULL),
  CONSTRAINT bans_period CHECK (ends_at IS NULL OR ends_at > starts_at)
);
CREATE INDEX bans_account_idx ON bans (account_id) WHERE lifted_at IS NULL;
CREATE INDEX bans_visitor_idx ON bans (visitor_id) WHERE lifted_at IS NULL;
CREATE INDEX bans_ip_idx ON bans (ip) WHERE lifted_at IS NULL;
CREATE INDEX bans_created_idx ON bans (created_at DESC);
