-- Reverses 0041_embedding_version.sql.
--
-- Refuses rather than choosing when a second generation exists: restoring the
-- three-column key fails on the duplicate chunks, and the transaction rolls back
-- with every vector intact. Deleting one generation to make room is a decision
-- for whoever runs the rollback, never for this file. The CHECK constraints go
-- with their columns.
ALTER TABLE "product_embeddings" DROP CONSTRAINT IF EXISTS "product_embeddings_tenant_product_chunk_version_unique";
--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_tenant_product_chunk_unique" UNIQUE("tenant_id","product_id","chunk_idx");
--> statement-breakpoint
ALTER TABLE "product_embeddings" DROP COLUMN IF EXISTS "version";
--> statement-breakpoint
ALTER TABLE "tenants" DROP COLUMN IF EXISTS "embedding_version";
