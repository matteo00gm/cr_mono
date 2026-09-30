-- Telling both wineries what a claim did (P4-18b, ADR 0028).
--
-- A notice exists so a paying holder can answer a claim before its origin
-- moves, and it protects nothing until the holder has actually been told. So
-- a claim records which of its states has been notified, and when: the claim
-- sweep sends the notice, stamps `notified_at`, and only then does the notice's
-- clock start. 0056 makes the policy refuse to settle a notice that has no
-- `notified_at`, so "transfer without telling anybody" is not a state the
-- database will act on.
ALTER TABLE "domain_claims" ADD COLUMN "notified_status" "domain_claim_status";
--> statement-breakpoint
ALTER TABLE "domain_claims" ADD COLUMN "notified_at" timestamp with time zone;
--> statement-breakpoint
-- What the sweep reads: claims whose current state has not been notified yet.
CREATE INDEX "domain_claims_unnotified_idx" ON "domain_claims" ("status")
  WHERE notified_status IS DISTINCT FROM status;
