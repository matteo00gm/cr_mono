-- How long a winery's chat transcripts are kept (P7-07, §3.9).
--
-- Null is the default — ninety days, held by the purge job rather than written
-- into every row, so the day the default changes it changes for every winery
-- that never chose. A value is that winery's own choice, from a day to ten
-- years: below a day there is nothing a seller could read, and past ten years
-- "how long" has stopped being a retention period and become a promise to keep
-- personal data indefinitely, which is not one this product makes.
ALTER TABLE "tenants" ADD COLUMN "transcript_retention_days" integer;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_transcript_retention_range"
  CHECK ("transcript_retention_days" IS NULL OR "transcript_retention_days" BETWEEN 1 AND 3650);
