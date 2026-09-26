-- Reverses 0050_mfa_step_up.sql.
--
-- Both are safe to drop. The claims are spent codes whose windows close within
-- ninety seconds, and `last_verified_at` is a freshness mark that every session
-- regains at its next second factor — nothing either holds outlives the
-- rollback that removes it.
DROP TABLE IF EXISTS "auth_totp_claims";

ALTER TABLE "auth_sessions" DROP COLUMN IF EXISTS "last_verified_at";
