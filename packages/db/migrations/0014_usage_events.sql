CREATE TABLE "usage_daily" (
	"tenant_id" uuid NOT NULL,
	"day" date NOT NULL,
	"messages" integer DEFAULT 0 NOT NULL,
	"conversations" integer DEFAULT 0 NOT NULL,
	"add_to_carts" integer DEFAULT 0 NOT NULL,
	"tokens_in" bigint DEFAULT 0 NOT NULL,
	"tokens_out" bigint DEFAULT 0 NOT NULL,
	"cost_micros" bigint DEFAULT 0 NOT NULL,
	CONSTRAINT "usage_daily_tenant_id_day_pk" PRIMARY KEY("tenant_id","day"),
	CONSTRAINT "usage_daily_cost_micros_non_negative" CHECK (cost_micros >= 0)
);
--> statement-breakpoint
CREATE TABLE "usage_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"period" text NOT NULL,
	"kind" text NOT NULL,
	"session_id" text,
	"input_tokens" integer,
	"output_tokens" integer,
	"cost_micros" bigint,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "usage_events_period_format" CHECK (period ~ '^[0-9]{6}$'),
	CONSTRAINT "usage_events_cost_micros_non_negative" CHECK (cost_micros is null or cost_micros >= 0)
);
--> statement-breakpoint
ALTER TABLE "usage_daily" ADD CONSTRAINT "usage_daily_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "usage_events" ADD CONSTRAINT "usage_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "usage_events_tenant_period_idx" ON "usage_events" USING btree ("tenant_id","period");