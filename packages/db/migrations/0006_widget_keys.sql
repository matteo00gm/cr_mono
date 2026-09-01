CREATE TABLE "widget_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"public_key" text NOT NULL,
	"secret_key_hash" text NOT NULL,
	"secret_key_prefix" text NOT NULL,
	"secret_key_last4" text NOT NULL,
	"revoked_at" timestamp with time zone,
	"grace_until" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_keys_public_key_unique" UNIQUE("public_key"),
	CONSTRAINT "widget_keys_grace_requires_revocation" CHECK (grace_until is null or revoked_at is not null),
	CONSTRAINT "widget_keys_last4_length" CHECK (char_length(secret_key_last4) = 4)
);
--> statement-breakpoint
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "widget_keys_one_active_per_tenant" ON "widget_keys" USING btree ("tenant_id") WHERE revoked_at is null;