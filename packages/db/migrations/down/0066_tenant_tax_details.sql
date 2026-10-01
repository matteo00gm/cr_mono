-- Reverses 0066_tenant_tax_details.sql.
--
-- The details go with the columns: a winery migrated up again is asked for
-- them at its next Checkout.
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_pec_address_format";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_sdi_code_format";
ALTER TABLE "tenants" DROP CONSTRAINT IF EXISTS "tenants_vat_id_format";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "pec_address";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "sdi_code";
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "vat_id";
