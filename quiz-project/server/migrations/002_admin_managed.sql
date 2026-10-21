-- Аккаунт, созданный сервером из ADMIN_LOGIN. Только такой аккаунт можно снова сделать администратором
-- (например, если ADMIN_LOGIN временно меняли). Аккаунт, зарегистрированный пользователем, — никогда.
ALTER TABLE accounts ADD COLUMN managed_by_env boolean NOT NULL DEFAULT false;
UPDATE accounts SET managed_by_env = true WHERE role = 'admin';
