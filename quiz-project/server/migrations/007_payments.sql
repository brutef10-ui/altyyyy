-- Оплата доступа к созданию своих игр: ведущий прикрепляет чек — доступ открывается сразу,
-- администратор проверяет чеки сам и при подделке блокирует аккаунт.
--
-- access_granted_at: когда открыт доступ. DEFAULT now() — у всех аккаунтов, созданных до появления оплаты
-- (и у восстановленных из старых резервных копий), доступ сохраняется; регистрация записывает NULL явно.
ALTER TABLE accounts ADD COLUMN access_granted_at timestamptz DEFAULT now();

-- Факт оплаты: кто, когда, с какого IP и браузера. Сам чек (receipt) хранится не дольше 2 суток,
-- затем удаляется (receipt_deleted_at). В резервные копии таблица не входит.
CREATE TABLE payments (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  account_id uuid NOT NULL REFERENCES accounts (id) ON DELETE CASCADE,
  visitor_id uuid REFERENCES visitors (id) ON DELETE SET NULL,
  ip inet,
  user_agent text,
  amount integer NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  receipt_type text,
  receipt_size integer,
  receipt bytea,
  receipt_deleted_at timestamptz,
  anonymized_at timestamptz
);
CREATE INDEX payments_created_idx ON payments (created_at DESC);
CREATE INDEX payments_account_idx ON payments (account_id);
CREATE INDEX payments_receipt_idx ON payments (created_at) WHERE receipt IS NOT NULL;
