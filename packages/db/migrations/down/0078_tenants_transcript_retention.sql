-- Reverses 0078_tenants_transcript_retention.sql.
--
-- A winery that chose a period loses the choice and is purged at the default
-- again: nothing else read the column.
ALTER TABLE "tenants" DROP CONSTRAINT "tenants_transcript_retention_range";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN "transcript_retention_days";
