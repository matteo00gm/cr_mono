-- A per-tenant embedding version, and room for two generations at once (P1-49).
--
-- Not a model migration: the affordance that makes one possible later without
-- taking every widget down. Retrieval against a half-backfilled table finds
-- nothing for the wines not yet embedded, so truncate-and-backfill is an outage
-- for as long as the backfill runs. With a version on every vector and a pointer
-- on every tenant, a second generation is written beside the first and each
-- tenant is switched only once its new set is complete — see
-- docs/runbooks/embedding-migration.md.
--
-- Both columns default to 1, the generation every stored vector already is, so
-- this rewrites no vector and changes no answer.
ALTER TABLE "tenants" ADD COLUMN "embedding_version" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "tenants" ADD CONSTRAINT "tenants_embedding_version_positive" CHECK ("embedding_version" >= 1);
--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD COLUMN "version" smallint DEFAULT 1 NOT NULL;
--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_version_positive" CHECK ("version" >= 1);
--> statement-breakpoint
-- The version joins the key, which is what lets two generations of one chunk
-- coexist. Dropped and re-added inside the migration's transaction, so there is
-- no moment at which a duplicate vector for one chunk and version could land.
ALTER TABLE "product_embeddings" DROP CONSTRAINT "product_embeddings_tenant_product_chunk_unique";
--> statement-breakpoint
ALTER TABLE "product_embeddings" ADD CONSTRAINT "product_embeddings_tenant_product_chunk_version_unique" UNIQUE("tenant_id","product_id","chunk_idx","version");
