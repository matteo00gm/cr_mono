CREATE TYPE "public"."widget_event_type" AS ENUM('WIDGET_OPEN', 'MESSAGE_SENT', 'RECOMMENDATION_SHOWN', 'PRODUCT_DETAIL_VIEW', 'ADD_TO_CART', 'CART_OPEN', 'ZERO_RESULTS');--> statement-breakpoint
CREATE TABLE "widget_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"conversation_id" uuid,
	"session_id" text NOT NULL,
	"type" "widget_event_type" NOT NULL,
	"product_id" uuid,
	"metadata" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_conversation_id_conversations_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversations"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_events" ADD CONSTRAINT "widget_events_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "widget_events_tenant_type_created_idx" ON "widget_events" USING btree ("tenant_id","type","created_at" DESC NULLS LAST);--> statement-breakpoint
CREATE INDEX "widget_events_session_idx" ON "widget_events" USING btree ("session_id","created_at");