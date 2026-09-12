-- Reverses 0038_products_edit_timestamp.sql.
--
-- Back to the shared trigger from 0001, which stamps every UPDATE. Guarded on
-- the table existing for the same reason every other reversal here is: the
-- table's own down file drops it, and rolling both back in order would
-- otherwise fail on a table that is gone.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'products') THEN
    DROP TRIGGER IF EXISTS products_set_updated_at ON products;

    CREATE TRIGGER products_set_updated_at
      BEFORE UPDATE ON products
      FOR EACH ROW
      EXECUTE FUNCTION set_updated_at();
  END IF;
END
$$;
--> statement-breakpoint
DROP FUNCTION IF EXISTS products_set_updated_at();
