-- Every paid charge a FatturaPA may be owed for (P5-03a).
--
-- One row per Stripe invoice or top-up payment, written by the webhook on its
-- claim's transaction. Recorded for every winery and decided at sending time:
-- a winery's invoice details (P5-02a) can arrive after its payment, because
-- Stripe sends invoice.paid and checkout.session.completed in either order, and
-- a charge skipped for want of them would be an invoice nobody issues.
--
-- Unique on the Stripe object, because a successful payment is reported twice
-- (invoice.paid and invoice.payment_succeeded) and is one charge.
--
-- The bridge records what it did, so app_rw keeps UPDATE; it gives up DELETE,
-- because a charge erased is an invoice nobody issues. Row-level security is
-- 0068, generated from src/rls.ts like every other policy.
CREATE TABLE "e_invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"stripe_object_id" text NOT NULL,
	"source" text NOT NULL,
	"amount_cents" bigint NOT NULL,
	"currency" text NOT NULL,
	"paid_at" timestamp with time zone NOT NULL,
	"status" text DEFAULT 'pending' NOT NULL,
	"provider_document_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "e_invoices_stripe_object_id_unique" UNIQUE("stripe_object_id"),
	CONSTRAINT "e_invoices_source" CHECK (source in ('invoice', 'top_up')),
	CONSTRAINT "e_invoices_amount_positive" CHECK (amount_cents > 0),
	CONSTRAINT "e_invoices_status" CHECK (status in ('pending', 'issued', 'not_required'))
);
--> statement-breakpoint
ALTER TABLE "e_invoices" ADD CONSTRAINT "e_invoices_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "e_invoices_tenant_status_idx" ON "e_invoices" USING btree ("tenant_id","status");
--> statement-breakpoint
REVOKE DELETE ON e_invoices FROM app_rw;
