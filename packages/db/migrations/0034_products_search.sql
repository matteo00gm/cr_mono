-- Lexical search over the catalogue (P1-07).
--
-- Half of hybrid retrieval (§4.4), and the half that finds grape and producer
-- names — which is what wine queries are mostly made of. A visitor asking for
-- "un nebbiolo del piemonte" is naming two things that are in the row verbatim;
-- an embedding is the wrong tool for that and a `LIKE` is the wrong tool for
-- everything else.

-- The `italian` configuration exists in every stock Postgres, so this needs no
-- extension of its own — but it is asserted rather than assumed, because a
-- database built without the Italian dictionary would otherwise silently index
-- with `simple` and stop stemming, and the symptom is "search finds fewer
-- things than it should" months later.
DO $$
BEGIN
  PERFORM 1 FROM pg_ts_config WHERE cfgname = 'italian';
  IF NOT FOUND THEN
    RAISE EXCEPTION 'the italian text search configuration is missing; P1-07 needs it';
  END IF;
END
$$;

-- **There is no `unaccent` in this column, and that is a constraint rather than
-- an oversight. Three attempts established it, each rejected by Postgres:**
--
--   * `unaccent()` is STABLE, not IMMUTABLE — its dictionary can be reloaded —
--     so it cannot appear in a generated column or an expression index.
--   * A SQL wrapper marked IMMUTABLE does not help. Without a `SET` clause it
--     is *inlinable*, so Postgres expands it and sees the STABLE function
--     underneath (`42P17`); with a `SET search_path` clause it is not inlinable
--     and still fails, because a function carrying one cannot appear in a
--     stored generation expression either.
--   * PostgreSQL's own recipe — declaring the extension's C entry point a
--     second time as IMMUTABLE — needs **superuser** to create a C function, and
--     migrations run as `app_migrate` (`42501`). Nor would raising that help:
--     RDS's master is `rds_superuser` and not a superuser either (P0-21b).
--
-- So accent folding is not available in the stored column for this deployment
-- model, and the plan's "accent-insensitivity via `unaccent`" cannot be built
-- as written. **What replaces it is the trigram fallback (P1-08):** a search for
-- `nebbiolo` against a stored `Nebbiòlo` misses the tsquery and is caught by
-- similarity — which the API already reports honestly as `matchedBy: 'similar'`
-- rather than passing it off as an exact match. That is a real degradation and
-- it is worth naming: accented spellings become fuzzy matches rather than exact
-- ones, and rank below an exact hit.

-- Generated, not trigger-maintained, and the difference is that a generated
-- column cannot drift. A trigger can be dropped, disabled, or skipped by a
-- `COPY` — and the failure is invisible, because the column still exists and
-- still holds whatever it last held.
--
-- The weights say what a match is worth: the name and the producer are what a
-- person is most likely to be naming, the grapes and the region next, and the
-- denomination last because it is the field most often left empty.
ALTER TABLE products ADD COLUMN search_tsv tsvector
  GENERATED ALWAYS AS (
    setweight(to_tsvector('italian', coalesce(name, '')), 'A') ||
    setweight(to_tsvector('italian', coalesce(producer, '')), 'A') ||
    setweight(
      to_tsvector('italian', array_to_string(coalesce(grape_varieties, '{}'), ' ')),
      'B'
    ) ||
    setweight(to_tsvector('italian', coalesce(region, '')), 'B') ||
    setweight(to_tsvector('italian', coalesce(denomination, '')), 'C')
  ) STORED;

CREATE INDEX products_search_idx ON products USING gin (search_tsv);

-- Grape queries are containment checks — "does this wine include Nebbiolo" —
-- which is what a GIN index over an array answers. Without it the filter is a
-- scan over every row in the tenant.
CREATE INDEX products_grapes_idx ON products USING gin (grape_varieties);

-- Trigrams, for the half of search that stemming cannot help with: real
-- visitors misspell producer names constantly, and a tsquery for `Poderi Cola`
-- matches nothing at all. This is also where accented spellings land now, since
-- the stored vector cannot fold them.
CREATE INDEX products_name_trgm_idx ON products USING gin (name gin_trgm_ops);
CREATE INDEX products_producer_trgm_idx
  ON products USING gin ((coalesce(producer, '')) gin_trgm_ops);
