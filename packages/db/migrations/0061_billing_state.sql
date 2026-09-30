-- The subscription state machine's columns, and the invariant that guards
-- every service decision (P5-05, §5.2b).
--
-- `trial_ends_at`: the card-free trial's end. Set when a winery's first domain
-- is verified, and required while it is TRIALING.
--
-- `billing_event_at`: when the last applied Stripe event was created. The
-- ordering guard reads it: an event created before it is ignored, because
-- Stripe delivers out of order and, with no grace period, a late
-- `payment_failed` would darken a winery that has since paid.
ALTER TABLE "tenants" ADD COLUMN "trial_ends_at" timestamptz;--> statement-breakpoint
ALTER TABLE "tenants" ADD COLUMN "billing_event_at" timestamptz;--> statement-breakpoint

-- Rows written before the machine existed, made coherent so the constraint can
-- be added. A TRIALING row gets the trial it would have been given. An ACTIVE
-- row with no subscription is the orphan the constraint exists to forbid; it
-- becomes a trial from today rather than going dark, because whatever served
-- it until now was not a payment, and a trial is the one served state that
-- needs none. Nothing is deployed, so these reach development data only.
UPDATE "tenants" SET "trial_ends_at" = "created_at" + interval '14 days'
WHERE "status" = 'TRIALING' AND "trial_ends_at" IS NULL;--> statement-breakpoint
UPDATE "tenants" SET "status" = 'TRIALING', "trial_ends_at" = now() + interval '14 days'
WHERE "status" = 'ACTIVE' AND "stripe_subscription_id" IS NULL;--> statement-breakpoint

-- §5.2b, as written there. ACTIVE without a subscription is unreachable by any
-- code path, including a future bug, rather than merely untested for.
ALTER TABLE "tenants" ADD CONSTRAINT "tenant_status_coherent" CHECK (
  ("status" <> 'ACTIVE' OR "stripe_subscription_id" IS NOT NULL) AND
  ("status" <> 'TRIALING' OR "trial_ends_at" IS NOT NULL)
);
