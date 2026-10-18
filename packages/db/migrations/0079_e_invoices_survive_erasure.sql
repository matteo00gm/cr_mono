-- A winery's paid charges outlive the winery (P7-08, ADR 0033).
--
-- Erasing a winery deletes everything it had except its fiscal records: a
-- charge is the record of a sale an invoice is owed for, and Italian law keeps
-- those for ten years whatever the customer asks (GDPR Art. 17(3)(b)). Every
-- other table cascades from `tenants`; this one now lets go instead.
--
-- **The erasure lets go through the foreign key itself.** `ON DELETE SET NULL`
-- is an action the database takes, under no row-level policy, at the moment
-- the winery's row goes. Detaching the rows any other way would mean writing
-- `tenant_id = NULL` under a policy whose WITH CHECK refuses exactly that.
--
-- **A detached charge carries its buyer.** Once the winery's row is gone, its
-- name and its fiscal identity are gone with it, and a charge nobody can name
-- the buyer of is not a fiscal record. The erasure copies them onto every
-- charge first; the CHECK below makes "copy, then detach" the only order that
-- works, so a detachment with nothing copied fails the whole erasure.
ALTER TABLE "e_invoices" ADD COLUMN "buyer_name" text;
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD COLUMN "buyer_vat_id" text;
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD COLUMN "buyer_sdi_code" text;
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD COLUMN "buyer_pec_address" text;
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD COLUMN "buyer_kept_at" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "e_invoices" ALTER COLUMN "tenant_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP CONSTRAINT "e_invoices_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_detached_keeps_buyer"
  CHECK ("tenant_id" IS NOT NULL OR ("buyer_name" IS NOT NULL AND "buyer_kept_at" IS NOT NULL));
