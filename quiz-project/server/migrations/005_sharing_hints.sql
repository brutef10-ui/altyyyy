-- Этап 7: подсказки о совместном использовании аккаунтов (только для показа администратору).
-- «Скрыть из списка»: администратор посмотрел аккаунт и не хочет видеть его среди подозрительных.
CREATE TABLE sharing_hidden (
  account_id uuid PRIMARY KEY REFERENCES accounts (id) ON DELETE CASCADE,
  hidden_by uuid REFERENCES accounts (id) ON DELETE SET NULL,
  hidden_by_login text,
  hidden_at timestamptz NOT NULL DEFAULT now()
);
