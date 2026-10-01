-- Reverses 0065_notification_events_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON notification_events;
ALTER TABLE notification_events NO FORCE ROW LEVEL SECURITY;
ALTER TABLE notification_events DISABLE ROW LEVEL SECURITY;
