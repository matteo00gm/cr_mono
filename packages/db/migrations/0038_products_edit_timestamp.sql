-- `products.updated_at` means "when did the seller last change this wine".
--
-- It did not, until now. P0-22's shared trigger sets `updated_at = now()` on
-- *every* UPDATE, and since P1-37 the embedding worker writes three columns on
-- every product it indexes. So a bulk re-index — a model change, a text-version
-- bump, a backlog draining after an outage — moves every wine in the catalogue
-- to the top of "recently edited" without a seller having touched one.
--
-- That matters because `updated_at` is not an internal timestamp here: P1-06
-- offers it as a sort field, so it is a thing sellers order their catalogue by.
-- A sort that reshuffles itself for reasons invisible to the person reading it
-- is worse than no sort, because they will believe it.
--
-- **The fix is a products-specific trigger that ignores the three embedding
-- columns**, rather than a second timestamp. Two columns would mean every
-- future reader choosing between them, and the one thing anybody wanted from
-- the second — when did this wine's embedding last change — is already
-- recorded, beside the vector, in `product_embeddings.created_at`.
--
-- The comparison is over `to_jsonb(row)` minus those columns rather than a list
-- of the columns that *do* count. That direction is the safe one: a column
-- added later counts as an edit by default, so forgetting to update this
-- function makes a timestamp move slightly too often, never too rarely.
CREATE OR REPLACE FUNCTION products_set_updated_at() RETURNS trigger AS $$
DECLARE
  -- `updated_at` itself is excluded, or the comparison would never be equal:
  -- this is a BEFORE trigger, and NEW.updated_at still holds the old value
  -- only because nothing has assigned it yet.
  ignored text[] := ARRAY['updated_at', 'embedding_state', 'embedding_error', 'embedding_attempts'];
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
-- Replaced rather than added: two BEFORE UPDATE triggers on one table fire in
-- name order, and the generic one would win or lose depending on the alphabet.
DROP TRIGGER IF EXISTS products_set_updated_at ON products;
--> statement-breakpoint
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION products_set_updated_at();
