-- Reverse of 0053 (P0-40).
--
-- Runs after 0054's reverse has removed the policies, so this drops the table
-- and its type alone. Every claim is lost, including notices a paying holder
-- has been served — so a reversal to run before claims exist, not after.
DROP TRIGGER IF EXISTS domain_claims_set_updated_at ON domain_claims;
DROP TABLE IF EXISTS "domain_claims";
DROP TYPE IF EXISTS "public"."domain_claim_status";
