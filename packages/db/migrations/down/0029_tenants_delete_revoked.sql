-- Reverses 0029_tenants_delete_revoked.sql.
--
-- Restores only what P0-21's default privileges would have granted. Guarded
-- because 0001's down file drops the table, and rolling both back in order
-- would otherwise fail here on a table that no longer exists.
--
-- Worth knowing what this restores: app_rw regains the ability to delete a
-- tenant, and with it the ability to erase `usage_events`, `audit_log` and
-- `security_events` by cascade. Rolling this migration back re-opens the gap
-- P0-33a closed.
DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_tables WHERE tablename = 'tenants') THEN
    GRANT DELETE ON tenants TO app_rw;
  END IF;
END
$$;
