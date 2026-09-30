-- Development mode (P4-19b, §3.3).
--
-- A seller's developer works on `http://localhost:3000`, and P2-05 refuses
-- `localhost` in production, correctly: a permanent localhost allowance would
-- let anyone holding a scraped `pk_` drive the API from their own machine for
-- ever. So the allowance is one exact origin, for twenty-four hours, and the
-- expiry lives in the database — 0059's policy stops admitting the winery the
-- moment `dev_mode_expires_at` passes, whatever the code asking believes.
--
-- One exact origin, never `localhost:*`: CORS matching is exact-set equality
-- (§3.4), and a port wildcard would be the pattern the invariant forbids.
ALTER TABLE "tenants" ADD COLUMN "dev_origin" text;
--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "dev_mode_expires_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_dev_mode_complete"
  CHECK ((dev_origin IS NULL) = (dev_mode_expires_at IS NULL));
--> statement-breakpoint
-- Local addresses only. Whatever normalises the input, the database will not
-- hold a public origin here, where no DNS proof ever stood behind it.
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_dev_origin_local"
  CHECK (dev_origin IS NULL OR dev_origin ~ '^https?://([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)*localhost(:[0-9]{1,5})?$');
