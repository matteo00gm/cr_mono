-- Reverse of 0055 (P0-40).
--
-- Runs after 0056's reverse has put the policies back, so nothing reads these
-- columns any more. Which notifications went out is lost, and a claim sweep
-- run afterwards would not know a notice had been sent.
DROP INDEX IF EXISTS "domain_claims_unnotified_idx";
ALTER TABLE "domain_claims" DROP COLUMN IF EXISTS "notified_at";
ALTER TABLE "domain_claims" DROP COLUMN IF EXISTS "notified_status";
