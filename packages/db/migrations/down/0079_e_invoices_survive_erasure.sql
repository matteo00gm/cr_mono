-- Reverses 0079_e_invoices_survive_erasure.sql — unless a winery has been
-- erased since, and then it refuses.
--
-- A detached charge has no winery to point at any more, so `tenant_id` cannot
-- be made NOT NULL again without deleting it, and deleting it is destroying a
-- fiscal record the law says to keep. A rollback is not a reason to do that,
-- so this stops and says why, and the charges stay where they are.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM "e_invoices" WHERE "tenant_id" IS NULL) THEN
    RAISE EXCEPTION
      'e_invoices holds charges of an erased winery; reversing 0079 would destroy fiscal records (ADR 0033)';
  END IF;
END
$$;
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP CONSTRAINT "e_invoices_detached_keeps_buyer";
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP CONSTRAINT "e_invoices_tenant_id_tenants_id_fk";
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "e_invoices" ALTER COLUMN "tenant_id" SET NOT NULL;
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP COLUMN "buyer_kept_at";
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP COLUMN "buyer_pec_address";
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP COLUMN "buyer_sdi_code";
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP COLUMN "buyer_vat_id";
--> statement-breakpoint
ALTER TABLE "e_invoices" DROP COLUMN "buyer_name";
