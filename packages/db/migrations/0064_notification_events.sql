-- The quota notices a month has already sent (P5-12).
--
-- One row per winery, per period, per threshold (80 or 100), and the primary
-- key is the idempotency: a notice is claimed by inserting its row, and a
-- second claim — two messages crossing the line at once, or a retry — finds
-- the key taken and sends nothing. A new month is a new period, so its notices
-- go out afresh.
--
-- Append-only at the grant, for the reason processed_webhooks is: deleting a
-- row here sends the notice again. Row-level security is 0065, generated from
-- src/rls.ts like every other policy.
CREATE TABLE "notification_events" (
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"threshold" smallint NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_events_tenant_id_period_threshold_pk" PRIMARY KEY("tenant_id","period","threshold"),
	CONSTRAINT "notification_events_period_format" CHECK (period ~ '^[0-9]{6}$'),
	CONSTRAINT "notification_events_threshold" CHECK (threshold in (80, 100))
);
--> statement-breakpoint
ALTER TABLE "notification_events" ADD CONSTRAINT "notification_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
REVOKE UPDATE, DELETE ON notification_events FROM app_rw;
