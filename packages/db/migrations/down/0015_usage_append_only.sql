-- Reverses 0015_usage_append_only.sql.
--
-- Restores what P0-21's default privileges would have granted, rather than
-- granting everything: the reverse of a revoke is the grant that preceded it,
-- and app_rw was never meant to hold anything beyond the four DML verbs.
--
-- Guarded, because 0014's down file drops the table. Rolling back both in order
-- would otherwise fail here on a table that no longer exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'usage_events') THEN
    GRANT UPDATE, DELETE ON usage_events TO app_rw;
  END IF;
END
$$;
