ALTER TABLE "auth_accounts" DROP CONSTRAINT "auth_accounts_provider_account_unique";--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD COLUMN "issuer" text NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_two_factor" ADD COLUMN "verified" boolean DEFAULT true NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_two_factor" ADD COLUMN "failed_verification_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_two_factor" ADD COLUMN "locked_until" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "auth_users" ADD COLUMN "two_factor_enabled" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "auth_accounts" ADD CONSTRAINT "auth_accounts_issuer_account_unique" UNIQUE("issuer","account_id");