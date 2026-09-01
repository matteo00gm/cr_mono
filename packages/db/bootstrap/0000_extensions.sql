-- Extensions (P0-20).
--
-- Bootstrap, not a migration, because CREATE EXTENSION needs privileges the
-- migration role deliberately does not have: on RDS it requires rds_superuser,
-- which app_migrate is not. Granting them to make this a normal migration would
-- hand DDL-time superuser to the role that runs on every deploy. See README.md.
--
-- IF NOT EXISTS throughout: this file is applied to every new database and
-- re-applied whenever the bootstrap is re-run, so it has to be idempotent.

-- Vector similarity search. Retrieval depends on it (P0-27).
CREATE EXTENSION IF NOT EXISTS vector;

-- Trigram matching, for the lexical half of hybrid retrieval (P1-07).
CREATE EXTENSION IF NOT EXISTS pg_trgm;

-- Accent-insensitive search: "Barbaresco" must match "Barbarèsco" (§4.4).
CREATE EXTENSION IF NOT EXISTS unaccent;

-- Case-insensitive text, for tenants.slug (P0-22). Enabled here rather than in
-- its own later migration so that a database is fully equipped after bootstrap
-- and no table migration ever has to reach for superuser privileges.
CREATE EXTENSION IF NOT EXISTS citext;

-- Fail here, loudly, if the server cannot support halfvec.
--
-- P0-27 commits product_embeddings to halfvec(1024) for the 3x memory reduction
-- that keeps the HNSW index in shared_buffers (§5.1). halfvec arrived in
-- pgvector 0.7.0. Without this check the failure surfaces at P0-27 as an opaque
-- "type does not exist" against a database that is already half built.
--
-- The assertion is on the type rather than on a parsed version string: the type
-- is the thing actually required, and comparing "0.10.0" to "0.7.0" as text is
-- a bug waiting for pgvector's tenth minor release.
DO $$
BEGIN
  IF to_regtype('halfvec') IS NULL THEN
    RAISE EXCEPTION
      'pgvector % does not provide halfvec; 0.7.0 or later is required (P0-27)',
      (SELECT extversion FROM pg_extension WHERE extname = 'vector');
  END IF;
END
$$;
