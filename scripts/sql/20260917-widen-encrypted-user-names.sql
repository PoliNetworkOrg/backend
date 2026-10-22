-- Incident repair: preserve complete encrypted Unicode names.
-- Applies only the two column limits; does not run unrelated pending migrations.
BEGIN;
SET LOCAL lock_timeout = '500ms';
SET LOCAL statement_timeout = '5s';
ALTER TABLE public.tg_users
  ALTER COLUMN first_name TYPE varchar(512),
  ALTER COLUMN last_name TYPE varchar(512);
COMMIT;
