-- Reverses 0034_products_search.sql.
--
-- The indexes go with the column, so they are not named separately: a rollback
-- that already dropped the column would fail on the second run otherwise.
-- `immutable_unaccent` is dropped last, because the expression indexes above
-- depend on it and Postgres refuses to drop a function while they exist.
ALTER TABLE products DROP COLUMN IF EXISTS search_tsv;
DROP INDEX IF EXISTS products_grapes_idx;
DROP INDEX IF EXISTS products_name_trgm_idx;
DROP INDEX IF EXISTS products_producer_trgm_idx;
DROP FUNCTION IF EXISTS immutable_unaccent(text);
