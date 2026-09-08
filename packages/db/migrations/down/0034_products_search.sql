-- Reverses 0034_products_search.sql.
--
-- The `search_tsv` index goes with the column, so it is not named separately: a
-- rollback that already dropped the column would fail on the second run.
ALTER TABLE products DROP COLUMN IF EXISTS search_tsv;
DROP INDEX IF EXISTS products_grapes_idx;
DROP INDEX IF EXISTS products_name_trgm_idx;
DROP INDEX IF EXISTS products_producer_trgm_idx;
