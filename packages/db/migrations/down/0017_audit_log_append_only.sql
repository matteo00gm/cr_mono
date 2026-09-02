-- Reverses 0017_audit_log_append_only.sql.
--
-- Restores only what P0-21's default privileges would have granted. Guarded
-- because 0016's down file drops the table, and rolling both back in order
-- would otherwise fail here on a table that no longer exists.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'audit_log') THEN
    GRANT UPDATE, DELETE ON audit_log TO app_rw;
  END IF;
END
$$;
