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

-- `unaccent()` is STABLE, not IMMUTABLE — its dictionary can be reloaded — so
-- Postgres refuses it in a generated column or an expression index. Wrapping it
-- in a SQL function marked IMMUTABLE does **not** help, and finding out why took
-- two CI runs:
--
--   * Without a `SET` clause the wrapper is *inlinable*, so Postgres expands it
--     and sees the STABLE `unaccent` underneath. `42P17`.
--   * With a `SET search_path` clause it is not inlinable — and still `42P17`,
--     because a function carrying one cannot appear in a stored generation
--     expression either.
--
-- The recipe that works is PostgreSQL's own, from the `unaccent` documentation:
-- declare the extension's C entry point a second time, as IMMUTABLE. Inlining
-- then exposes nothing mutable, because there is nothing underneath.
--
-- **The immutability is asserted rather than true, and that is the trade.** If
-- somebody edits `unaccent.rules` on a running database, rows keep the folding
-- they were indexed with until they are rewritten. Against that: `nebbiolo`
-- matches `Nebbiòlo`, which is what Italian visitors type — and the only
-- alternative is unaccenting at query time, which cannot use an index at all.
CREATE OR REPLACE FUNCTION immutable_unaccent_dict(regdictionary, text)
  RETURNS text
  LANGUAGE c
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS '$libdir/unaccent', 'unaccent_dict';

-- The one-argument form the expressions below call. Schema-qualified inside, so
-- a caller cannot redirect resolution with their own `search_path` — which is
-- the escalation shape an IMMUTABLE function called during an index build would
-- otherwise have.
CREATE OR REPLACE FUNCTION immutable_unaccent(text)
  RETURNS text
  LANGUAGE sql
  IMMUTABLE
  PARALLEL SAFE
  STRICT
AS $$
  SELECT public.immutable_unaccent_dict('public.unaccent'::regdictionary, $1)
$$;

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
    setweight(to_tsvector('italian', immutable_unaccent(coalesce(name, ''))), 'A') ||
    setweight(to_tsvector('italian', immutable_unaccent(coalesce(producer, ''))), 'A') ||
    setweight(
      to_tsvector('italian', immutable_unaccent(array_to_string(coalesce(grape_varieties, '{}'), ' '))),
      'B'
    ) ||
    setweight(to_tsvector('italian', immutable_unaccent(coalesce(region, ''))), 'B') ||
    setweight(to_tsvector('italian', immutable_unaccent(coalesce(denomination, ''))), 'C')
  ) STORED;

CREATE INDEX products_search_idx ON products USING gin (search_tsv);

-- Grape queries are containment checks — "does this wine include Nebbiolo" —
-- which is what a GIN index over an array answers. Without it the filter is a
-- scan over every row in the tenant.
CREATE INDEX products_grapes_idx ON products USING gin (grape_varieties);

-- Trigrams, for the half of search that stemming cannot help with: real
-- visitors misspell producer names constantly, and a tsquery for `Poderi Cola`
-- matches nothing at all. Unaccented for the same reason as the tsvector, so
-- the fallback does not become the accent-sensitive path.
CREATE INDEX products_name_trgm_idx ON products USING gin (immutable_unaccent(name) gin_trgm_ops);
CREATE INDEX products_producer_trgm_idx
  ON products USING gin (immutable_unaccent(coalesce(producer, '')) gin_trgm_ops);
