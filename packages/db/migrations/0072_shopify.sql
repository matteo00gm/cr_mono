-- The Shopify install (P6-06, ADR 0031).
--
-- A third way to prove a domain (§3.3): Shopify asked the shop's owner, and
-- the install is their answer. `shopify_installations` holds which shop each
-- winery connected — unique across wineries, because the orders a shop
-- reports (P6-07) are attributed to the winery that holds it — and never the
-- token, which is a credential and lives encrypted in SSM. `shopify_oauth_states`
-- holds an install that was started and not finished: a nonce's hash, bound
-- to the member who started it, spent by being deleted.
--
-- app_rw gives up DELETE on installations: an uninstall is recorded, not
-- erased, because P6-07's attributions point at it. Row-level security is
-- 0073, generated from src/rls.ts like every other policy.
ALTER TYPE "domain_verification_method" ADD VALUE IF NOT EXISTS 'SHOPIFY';
--> statement-breakpoint
CREATE TABLE "shopify_installations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shop" text NOT NULL,
	"scopes" text NOT NULL,
	"installed_at" timestamp with time zone DEFAULT now() NOT NULL,
	"uninstalled_at" timestamp with time zone,
	CONSTRAINT "shopify_installations_shop_unique" UNIQUE("shop"),
	CONSTRAINT "shopify_installations_shop_format" CHECK (shop ~ '^[a-z0-9][a-z0-9-]{0,59}\.myshopify\.com$')
);
--> statement-breakpoint
ALTER TABLE "shopify_installations" ADD CONSTRAINT "shopify_installations_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "shopify_installations_tenant_id_idx" ON "shopify_installations" USING btree ("tenant_id");
--> statement-breakpoint
REVOKE DELETE ON shopify_installations FROM app_rw;
--> statement-breakpoint
CREATE TABLE "shopify_oauth_states" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"user_id" text NOT NULL,
	"shop" text NOT NULL,
	"nonce_hash" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "shopify_oauth_states_nonce_hash_unique" UNIQUE("nonce_hash")
);
--> statement-breakpoint
ALTER TABLE "shopify_oauth_states" ADD CONSTRAINT "shopify_oauth_states_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "shopify_oauth_states" ADD CONSTRAINT "shopify_oauth_states_user_id_auth_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."auth_users"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
CREATE INDEX "shopify_oauth_states_user_id_idx" ON "shopify_oauth_states" USING btree ("user_id");
