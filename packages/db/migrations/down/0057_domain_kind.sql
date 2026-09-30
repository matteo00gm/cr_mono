-- Reverse of 0057 (P0-40).
--
-- Every staging origin becomes indistinguishable from a production one, so a
-- winery with staging origins may find itself over its plan's domain cap —
-- a reversal to run before staging origins exist, not after.
ALTER TABLE "tenant_domains" DROP COLUMN IF EXISTS "kind";
DROP TYPE IF EXISTS "public"."domain_kind";
