-- Оплата — для всех аккаунтов: доступ к созданию игр есть только у тех, кто прикрепил чек.
-- (В 007 аккаунты, созданные до появления оплаты, сохраняли доступ — это отменено.)
ALTER TABLE accounts ALTER COLUMN access_granted_at DROP DEFAULT;
UPDATE accounts a SET access_granted_at = NULL
 WHERE access_granted_at IS NOT NULL
   AND NOT EXISTS (SELECT 1 FROM payments p WHERE p.account_id = a.id);
