CREATE TYPE "public"."tenant_plan" AS ENUM('CANTINA', 'ECOMMERCE');--> statement-breakpoint
CREATE TYPE "public"."tenant_status" AS ENUM('PENDING_VERIFICATION', 'TRIALING', 'ACTIVE', 'PAST_DUE', 'DISABLED', 'CANCELED');--> statement-breakpoint
CREATE TABLE "tenants" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" "citext" NOT NULL,
	"status" "tenant_status" DEFAULT 'PENDING_VERIFICATION' NOT NULL,
	"plan" "tenant_plan",
	"stripe_customer_id" text,
	"stripe_subscription_id" text,
	"locale" text DEFAULT 'it' NOT NULL,
	"currency" text DEFAULT 'EUR' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "tenants_slug_unique" UNIQUE("slug"),
	CONSTRAINT "tenants_stripe_customer_id_unique" UNIQUE("stripe_customer_id"),
	CONSTRAINT "tenants_stripe_subscription_id_unique" UNIQUE("stripe_subscription_id")
);
