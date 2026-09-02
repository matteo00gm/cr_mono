CREATE TYPE "public"."security_event_type" AS ENUM('UNAUTHORIZED_ORIGIN', 'INVALID_KEY', 'TOKEN_ORIGIN_MISMATCH', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'REPLAYED_WEBHOOK');--> statement-breakpoint
CREATE TABLE "security_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid,
	"type" "security_event_type" NOT NULL,
	"origin" text,
	"public_key" text,
	"ip" "inet",
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "security_events" ADD CONSTRAINT "security_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "security_events_tenant_type_created_idx" ON "security_events" USING btree ("tenant_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "security_events_key_origin_idx" ON "security_events" USING btree ("public_key","origin");