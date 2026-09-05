-- Reverses 0028_better_auth_1_7_fields.sql.
--
-- Every column here was added empty: Better Auth 1.7.2 requires them and
-- P0-23a's tables predate the library being wired, so nothing existed before
-- 0028 that dropping them could lose.
--
-- The tables themselves stay — they are 0026's, and rolling back the auth
-- wiring must not take every user account with it.
--
-- Reverse order of the up file, so the unique constraint that depends on
-- `issuer` goes before the column does.
ALTER TABLE "auth_accounts" DROP CONSTRAINT IF EXISTS "auth_accounts_issuer_account_unique";

ALTER TABLE "auth_users" DROP COLUMN IF EXISTS "two_factor_enabled";

ALTER TABLE "auth_two_factor" DROP COLUMN IF EXISTS "locked_until";

ALTER TABLE "auth_two_factor" DROP COLUMN IF EXISTS "failed_verification_count";

ALTER TABLE "auth_two_factor" DROP COLUMN IF EXISTS "verified";

ALTER TABLE "auth_accounts" DROP COLUMN IF EXISTS "issuer";

-- Restores the P0-23a constraint, so a rollback leaves the table exactly as
-- 0027 left it rather than merely unblocked.
ALTER TABLE "auth_accounts"
  ADD CONSTRAINT "auth_accounts_provider_account_unique" UNIQUE ("provider_id", "account_id");
