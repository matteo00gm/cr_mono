-- Reverses 0035_embedding_diagnostics.sql.
--
-- The index goes with the columns it is built on, so naming it separately would
-- fail on the second run of a rollback that already dropped them.
ALTER TABLE products DROP COLUMN IF EXISTS embedding_error;
ALTER TABLE products DROP COLUMN IF EXISTS embedding_attempts;
