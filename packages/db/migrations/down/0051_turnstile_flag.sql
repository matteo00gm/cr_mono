-- Reverses 0051_turnstile_flag.sql.
--
-- Dropping it turns the challenge off for every winery that had it on, which
-- is the rollback's intent: the code that reads the flag is going too.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "turnstile_enabled";
