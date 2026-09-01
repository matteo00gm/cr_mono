-- The HNSW index (P0-27).
--
-- A --custom migration because Drizzle cannot model an operator class on a
-- custom column type, and the operator class is the whole point of this index.
--
-- `halfvec_cosine_ops` has to match the operator retrieval actually uses, `<=>`.
-- The plan warned that naming `vector_cosine_ops` here fails silently; it does
-- not — Postgres refuses with "operator class vector_cosine_ops does not accept
-- data type halfvec", and omitting the opclass refuses too, because halfvec has
-- no default for hnsw. Both are loud, which is the good case.
--
-- What *is* silent is naming a valid opclass for the wrong distance:
-- `halfvec_l2_ops` builds without complaint and then never serves a `<=>`
-- query, so retrieval keeps returning correct results by sequential scan and
-- simply gets slower in proportion to the catalog. Verified on pgvector 0.8.0:
-- with an l2 index in place, the cosine query plans as a Seq Scan.
--
-- m = 16 / ef_construction = 64 are pgvector's defaults, stated explicitly
-- because they are a recall-versus-build-time trade-off worth seeing in a diff
-- if anyone changes them.
CREATE INDEX product_embeddings_embedding_hnsw
  ON product_embeddings
  USING hnsw (embedding halfvec_cosine_ops)
  WITH (m = 16, ef_construction = 64);
--> statement-breakpoint
-- Retrieval always filters by tenant before it ranks by distance, and RLS adds
-- that predicate whether or not the query does. Without this, the tenant filter
-- is applied by rechecking rows the vector scan already returned — so a tenant
-- with 50 products pays for a search across every tenant's vectors.
CREATE INDEX product_embeddings_tenant_idx ON product_embeddings (tenant_id);
