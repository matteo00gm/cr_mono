-- The wines the sommelier sold (P6-07, §2.4).
--
-- One row per line item of a Shopify order that carried the visit the widget
-- planted on it (P3-11): the order's id and the line's, the visit, the
-- conversation and wine when we know them, a quantity and what was paid.
-- Nothing about the buyer. The unique index is what makes a redelivered
-- `orders/create` count once.
--
-- app_rw gives up UPDATE: an amount a seller was shown is written once. It
-- keeps DELETE, because a shop's data goes when Shopify says it must
-- (`shop/redact`, P6-09). Row-level security is 0075, generated from
-- src/rls.ts like every other policy.
CREATE TABLE "attributions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"shop" text NOT NULL,
	"order_id" text NOT NULL,
	"line_item_id" text NOT NULL,
	"session_id" text NOT NULL,
	"conversation_id" uuid,
	"product_id" uuid,
	"quantity" integer NOT NULL,
	"amount_cents" integer NOT NULL,
	"currency" text NOT NULL,
	"ordered_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "attributions_quantity_positive" CHECK (quantity > 0),
	CONSTRAINT "attributions_amount_not_negative" CHECK (amount_cents >= 0),
	CONSTRAINT "attributions_currency_format" CHECK (currency ~ '^[A-Z]{3}$')
);
--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
ALTER TABLE "attributions" ADD CONSTRAINT "attributions_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;
--> statement-breakpoint
CREATE UNIQUE INDEX "attributions_tenant_order_line_key" ON "attributions" USING btree ("tenant_id","order_id","line_item_id");
--> statement-breakpoint
CREATE INDEX "attributions_tenant_ordered_idx" ON "attributions" USING btree ("tenant_id","ordered_at" DESC NULLS LAST);
--> statement-breakpoint
REVOKE UPDATE ON attributions FROM app_rw;
