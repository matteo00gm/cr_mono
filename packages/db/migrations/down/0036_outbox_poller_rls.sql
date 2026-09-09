-- Reverses 0036_outbox_poller_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON outbox;
CREATE POLICY tenant_isolation ON outbox
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
