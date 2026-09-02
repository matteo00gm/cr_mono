CREATE TYPE "public"."product_embedding_state" AS ENUM('PENDING', 'INDEXED', 'FAILED', 'STALE');--> statement-breakpoint
CREATE TYPE "public"."product_status" AS ENUM('ACTIVE', 'ARCHIVED');--> statement-breakpoint
CREATE TYPE "public"."product_stock_status" AS ENUM('IN_STOCK', 'OUT_OF_STOCK', 'PREORDER');--> statement-breakpoint
CREATE TABLE "products" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"sku" text NOT NULL,
	"external_variant_id" text,
	"name" text NOT NULL,
	"producer" text,
	"vintage" integer,
	"wine_type" text NOT NULL,
	"grape_varieties" text[],
	"region" text,
	"denomination" text,
	"style_tags" text[],
	"tasting_notes" text,
	"food_pairings" text[],
	"alcohol_pct" numeric(4, 2),
	"price_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"stock_status" "product_stock_status" NOT NULL,
	"stock_qty" integer,
	"product_url" text,
	"image_url" text,
	"status" "product_status" DEFAULT 'ACTIVE' NOT NULL,
	"content_hash" text,
	"embedding_state" "product_embedding_state" DEFAULT 'PENDING' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "products_tenant_sku_unique" UNIQUE("tenant_id","sku"),
	CONSTRAINT "products_price_non_negative" CHECK (price_cents >= 0),
	CONSTRAINT "products_stock_qty_non_negative" CHECK (stock_qty is null or stock_qty >= 0),
	CONSTRAINT "products_alcohol_pct_non_negative" CHECK (alcohol_pct is null or alcohol_pct >= 0)
);
--> statement-breakpoint
ALTER TABLE "products" ADD CONSTRAINT "products_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "products_tenant_status_idx" ON "products" USING btree ("tenant_id","status");--> statement-breakpoint
CREATE INDEX "products_tenant_embedding_state_idx" ON "products" USING btree ("tenant_id","embedding_state");