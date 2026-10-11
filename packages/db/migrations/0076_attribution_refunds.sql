-- A refund takes back part of what the sommelier sold (P6-08).
--
-- `attributions` becomes a ledger of two kinds of entry: a sale, as 0074 wrote
-- it, and a refund of one, which carries the refund line's id and a negative
-- quantity and amount. What a line is worth is the sum of its entries, so
-- nothing is ever rewritten — app_rw still holds no UPDATE here.
--
-- One key each: a sale once per order line, a refund line once ever. The sign
-- of an entry is held to its kind, so a sale cannot be written negative nor a
-- refund positive.
ALTER TABLE "attributions" ADD COLUMN "refund_line_id" text;
--> statement-breakpoint
DROP INDEX "attributions_tenant_order_line_key";
--> statement-breakpoint
CREATE UNIQUE INDEX "attributions_tenant_order_line_key" ON "attributions" USING btree ("tenant_id","order_id","line_item_id") WHERE "attributions"."refund_line_id" IS NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX "attributions_tenant_refund_line_key" ON "attributions" USING btree ("tenant_id","refund_line_id") WHERE "attributions"."refund_line_id" IS NOT NULL;
--> statement-breakpoint
ALTER TABLE "attributions" DROP CONSTRAINT "attributions_quantity_positive";
--> statement-breakpoint
ALTER TABLE "attributions" DROP CONSTRAINT "attributions_amount_not_negative";
--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_sign_matches_kind" CHECK ((refund_line_id IS NULL AND quantity > 0 AND amount_cents >= 0) OR (refund_line_id IS NOT NULL AND quantity < 0 AND amount_cents <= 0));
