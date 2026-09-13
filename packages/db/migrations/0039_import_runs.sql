-- One import attempt, keyed so a repeat applies once (P1-26).
--
-- A double-clicked confirm or a retry after a dropped connection would
-- otherwise run an import twice: harmless to the catalogue, since it is an
-- upsert by SKU, but it re-queues embeddings and duplicates the audit entry.
-- The unique key is per tenant, because a key is the client's choice and one
-- winery's must never collide with another's. Row-level security for the table
-- is 0040, generated from src/rls.ts like every other policy.
CREATE TABLE "import_runs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"idempotency_key" text NOT NULL,
	"request_hash" text NOT NULL,
	"result" jsonb,
	"claimed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"completed_at" timestamp with time zone,
	CONSTRAINT "import_runs_tenant_key_unique" UNIQUE("tenant_id","idempotency_key")
);
--> statement-breakpoint
ALTER TABLE "import_runs" ADD CONSTRAINT "import_runs_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
