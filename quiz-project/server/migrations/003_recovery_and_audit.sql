-- Этап 3: одноразовые коды восстановления от администратора и журнал действий администратора.

-- Код выдаёт администратор (кнопка в карточке пользователя). Показывается один раз, в БД — только SHA-256.
-- Действует ограниченное время, один раз и только для своего аккаунта; новый код отзывает прежние.
CREATE TABLE recovery_codes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  code_hash bytea NOT NULL,
  created_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  expires_at timestamptz NOT NULL,
  used_at timestamptz,
  revoked_at timestamptz,
  revoke_reason text,
  attempts integer NOT NULL DEFAULT 0
);
CREATE INDEX recovery_codes_active_idx ON recovery_codes (account_id) WHERE used_at IS NULL AND revoked_at IS NULL;

-- Журнал действий администратора (выдача кодов, блокировки, настройки). Хранится дольше журнала заходов.
CREATE TABLE admin_audit (
  id bigserial PRIMARY KEY,
  admin_id uuid REFERENCES accounts (id) ON DELETE SET NULL,
  admin_login text,
  action text NOT NULL,
  target_type text,
  target_id text,
  details jsonb NOT NULL DEFAULT '{}'::jsonb,
  ip inet,
  user_agent text,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX admin_audit_created_idx ON admin_audit (created_at DESC);
CREATE INDEX admin_audit_target_idx ON admin_audit (target_type, target_id, created_at DESC);
CREATE INDEX admin_audit_admin_idx ON admin_audit (admin_id, created_at DESC);
