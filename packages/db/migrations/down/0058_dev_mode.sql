-- Reverse of 0058 (P0-40).
--
-- Runs after 0059's reverse has put the tenants policy back. Any development
-- mode in force ends with it, which is the safe direction.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_dev_origin_local";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_dev_mode_complete";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dev_mode_expires_at";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "dev_origin";
