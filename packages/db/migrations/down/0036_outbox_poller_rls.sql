-- Reverses 0036_outbox_poller_rls.sql.

DROP POLICY IF EXISTS outbox_poller_read ON outbox;

DROP POLICY IF EXISTS outbox_poller_release ON outbox;
