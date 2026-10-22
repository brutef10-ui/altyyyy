-- Доверенные устройства администратора: в админ-консоль входят только с них (не больше ADMIN_MAX_DEVICES).
-- Устройство — посетитель (cookie vid). Логина и пароля без доверенного устройства недостаточно.
CREATE TABLE admin_devices (
  visitor_id uuid PRIMARY KEY REFERENCES visitors (id) ON DELETE CASCADE,
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  user_agent text,
  added_at timestamptz NOT NULL DEFAULT now(),
  last_seen_at timestamptz NOT NULL DEFAULT now(),
  last_ip inet
);
CREATE INDEX admin_devices_account_idx ON admin_devices (account_id);
