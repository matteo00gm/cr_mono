-- Reverses 0080_tenants_server_sessions_only.sql.
--
-- Dropping it opens the browser mint again for every winery that had shut it,
-- which is the rollback's intent: the code that reads the flag is going too.
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "server_sessions_only";
