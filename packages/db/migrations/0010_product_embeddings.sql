CREATE TABLE "product_embeddings" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"tenant_id" uuid NOT NULL,
	"product_id" uuid NOT NULL,
	"chunk_idx" integer NOT NULL,
	"content_hash" text NOT NULL,
	"embedding" halfvec(1024) NOT NULL,
	"model" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "product_embeddings_tenant_product_chunk_unique" UNIQUE("tenant_id","product_id","chunk_idx")
);
--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_tenant_id_tenants_id_fk" FOREIGN KEY ("tenant_id") REFERENCES "public"."tenants"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_product_id_products_id_fk" FOREIGN KEY ("product_id") REFERENCES "public"."products"("id") ON DELETE cascade ON UPDATE no action;