CREATE TYPE "public"."domain_status" AS ENUM('PENDING', 'VERIFIED');--> statement-breakpoint
CREATE TYPE "public"."domain_verification_method" AS ENUM('DNS_TXT', 'WELL_KNOWN');--> statement-breakpoint
CREATE TABLE "tenant_domains" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"origin" text NOT NULL,
	"registrable_domain" text NOT NULL,
	"status" "domain_status" DEFAULT 'PENDING' NOT NULL,
	"verification_method" "domain_verification_method",
	"verification_token" text,
	"verification_expires_at" timestamp with time zone,
	"verified_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenant_domains_origin_unique" UNIQUE("origin"),
	CONSTRAINT "tenant_domains_origin_format" CHECK (origin ~ '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$')
);
--> statement-breakpoint
ALTER TABLE "tenant_domains" ADD CONSTRAINT "tenant_domains_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "tenant_domains_tenant_id_idx" ON "tenant_domains" USING btree ("tenant_id");