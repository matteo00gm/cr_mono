-- Reverses 0049_secret_key_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON widget_keys;
CREATE POLICY tenant_isolation ON widget_keys
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR public_key = nullif(current_setting('app.widget_key', true), ''))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
