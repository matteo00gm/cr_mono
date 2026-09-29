-- Claiming an origin another winery holds (P4-18, §3.2, ADR 0028).
--
-- `UNIQUE(origin)` on `tenant_domains` is the anti-sharing backbone, and it
-- turns ordinary business events into dead ends: a winery churns and abandons
-- its account, the business is sold, an agency rebuilds the site under a new
-- workspace. Without this table the new owner cannot onboard at all.
--
-- A claim is proved exactly as a first verification is — a `_somm-verify` TXT
-- record on the registrable domain — and what happens next depends on the
-- holder: an abandoned or unpaid account loses the origin at once, a paying one
-- gets 72 hours' notice first.
--
-- **Two tenants on one row, and `tenant_id` is the claimant.** The claim is
-- theirs: they created it and they hold its nonce. `incumbent_tenant_id` is set
-- only once a proven claim puts a paying holder on notice, which is the moment
-- the holder needs to see it — and neither side is ever told who the other is.
CREATE TYPE "public"."domain_claim_status" AS ENUM(
  'PENDING',
  'PROVEN',
  'NOTICE',
  'TRANSFERRED',
  'CANCELED'
);
--> statement-breakpoint
CREATE TABLE "domain_claims" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "tenant_id" uuid NOT NULL REFERENCES "tenants"("id") ON DELETE CASCADE,
  "incumbent_tenant_id" uuid REFERENCES "tenants"("id") ON DELETE SET NULL,
  "origin" text NOT NULL,
  "registrable_domain" text NOT NULL,
  "status" "domain_claim_status" DEFAULT 'PENDING' NOT NULL,
  -- The claimant's own nonce, never the holder's. Single use, cleared on proof.
  "verification_token" text,
  "verification_expires_at" timestamp with time zone,
  "proven_at" timestamp with time zone,
  -- When a paying holder's notice runs out. Set with the notice, never before.
  "transfer_at" timestamp with time zone,
  "settled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  -- The same shape `tenant_domains` holds, so a claim can only ever name an
  -- origin that could be written there on transfer.
  CONSTRAINT "domain_claims_origin_format" CHECK (origin ~ '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$'),
  -- A notice names who it was served on and when it ends, or it is not one.
  CONSTRAINT "domain_claims_notice_complete" CHECK (
    status <> 'NOTICE' OR (incumbent_tenant_id IS NOT NULL AND transfer_at IS NOT NULL)
  )
);
--> statement-breakpoint
-- One open claim per winery per origin. Settled and withdrawn claims stay as a
-- record and do not block a fresh one.
CREATE UNIQUE INDEX "domain_claims_open_unique" ON "domain_claims" ("tenant_id", "origin")
  WHERE status IN ('PENDING', 'PROVEN', 'NOTICE');
--> statement-breakpoint
-- What the holder's dashboard reads: the claims served on it.
CREATE INDEX "domain_claims_incumbent_idx" ON "domain_claims" ("incumbent_tenant_id")
  WHERE incumbent_tenant_id IS NOT NULL;
--> statement-breakpoint
-- What the transfer sweep reads: notices, by when they run out.
CREATE INDEX "domain_claims_due_idx" ON "domain_claims" ("transfer_at")
  WHERE status = 'NOTICE';
--> statement-breakpoint
CREATE TRIGGER domain_claims_set_updated_at
  BEFORE UPDATE ON domain_claims
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
--
-- Row-level security is 0054, generated from `RLS_POLICIES` like every other
-- policy here (P0-37), together with the one branch on `tenant_domains` that a
-- proven claim opens.
