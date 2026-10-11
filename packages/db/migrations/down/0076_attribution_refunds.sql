-- Reverses 0076_attribution_refunds.sql.
--
-- The refunds go: the schema being restored has no way to say "less than was
-- sold", and a negative row left behind would break the checks it brings
-- back. The sales stay as they were written.
DELETE FROM "attributions" WHERE "refund_line_id" IS NOT NULL;
ALTER TABLE "attributions" DROP CONSTRAINT IF EXISTS "attributions_sign_matches_kind";
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_quantity_positive" CHECK (quantity > 0);
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_amount_not_negative" CHECK (amount_cents >= 0);
DROP INDEX IF EXISTS "attributions_tenant_refund_line_key";
DROP INDEX IF EXISTS "attributions_tenant_order_line_key";
CREATE UNIQUE INDEX "attributions_tenant_order_line_key" ON "attributions" USING btree ("tenant_id","order_id","line_item_id");
ALTER TABLE "attributions" DROP COLUMN IF EXISTS "refund_line_id";
