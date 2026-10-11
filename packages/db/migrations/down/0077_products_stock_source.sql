-- Reverses 0077_products_stock_source.sql.
--
-- The function goes back to 0038's body, word for word, before the column
-- goes — so it never names a column that is not there, and a database rolled
-- back to here is the one that was migrated to here.
CREATE OR REPLACE FUNCTION products_set_updated_at() RETURNS trigger AS $$
DECLARE
  -- `updated_at` itself is excluded, or the comparison would never be equal:
  -- this is a BEFORE trigger, and NEW.updated_at still holds the old value
  -- only because nothing has assigned it yet.
  --
  -- **`search_tsv` is excluded because it is GENERATED ALWAYS, and that is the
  -- trap this function walked into first.** Postgres computes a stored
  -- generated column *after* BEFORE triggers run, so inside here
  -- `NEW.search_tsv` is NULL while `OLD.search_tsv` holds last write's value.
  -- The two rows are therefore *always* distinct, whatever the statement
  -- actually changed — so the narrowing did nothing at all and every embedding
  -- write still moved the stamp. Nothing about that is visible in the function;
  -- it looks correct, and it was correct on a table with no generated column.
  --
  -- `products_generated_columns_are_ignored` in
  -- `embeddings.integration.test.ts` reads both lists out of the catalogue and
  -- fails if `products` gains another generated column that is not named here.
  ignored text[] := ARRAY[
    'updated_at',
    'search_tsv',
    'embedding_state',
    'embedding_error',
    'embedding_attempts'
  ];
BEGIN
  IF (to_jsonb(NEW) - ignored) IS DISTINCT FROM (to_jsonb(OLD) - ignored) THEN
    NEW.updated_at = now();
  ELSE
    NEW.updated_at = OLD.updated_at;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
ALTER TABLE IF EXISTS "products" DROP COLUMN IF EXISTS "stock_source_at";
