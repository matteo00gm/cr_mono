-- Reverses 0030_processed_webhooks_append_only.sql.
--
-- Restores only what P0-21's default privileges would have granted. Guarded for
-- the same reason as every other revoke reversal here: the table's own down
-- file drops it, and rolling both back in order would otherwise fail on a
-- table that no longer exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'processed_webhooks') THEN
    GRANT UPDATE, DELETE ON processed_webhooks TO app_rw;
  END IF;
END
$$;
