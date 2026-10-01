-- Messages bought on top of a plan (P5-11a).
--
-- One row per paid top-up, credited by Stripe's webhook to the month it was
-- paid in. The quota gate sums it per period before every model call, so the
-- period has the ledger's format and the same index shape as `usage_events`.
--
-- A ledger, so append-only at the grant: P0-21's default privileges hand
-- app_rw UPDATE and DELETE on every new table, and the row that says what a
-- winery paid for must not be editable by the code path that serves it. A
-- refund is a business decision taken elsewhere, not an UPDATE here.
--
-- The payment intent is unique across every tenant: one payment is one
-- credit, however many events Stripe sends about it. Row-level security is
-- 0063, generated from src/rls.ts like every other policy.
CREATE TABLE "usage_top_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"messages_purchased" integer NOT NULL,
	"stripe_payment_intent_id" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_top_ups_stripe_payment_intent_id_unique" UNIQUE("stripe_payment_intent_id"),
	CONSTRAINT "usage_top_ups_period_format" CHECK (period ~ '^[0-9]{6}$'),
	CONSTRAINT "usage_top_ups_messages_positive" CHECK (messages_purchased > 0)
);
--> statement-breakpoint
ALTER TABLE "usage_top_ups" ADD CONSTRAINT "usage_top_ups_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "usage_top_ups_tenant_period_idx" ON "usage_top_ups" USING btree ("tenant_id","period");
--> statement-breakpoint
REVOKE UPDATE, DELETE ON usage_top_ups FROM app_rw;
