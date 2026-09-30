-- Reverses 0059_dev_mode_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON tenants;
CREATE POLICY tenant_isolation ON tenants
  USING (id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR id IN (SELECT d.tenant_id FROM tenant_domains d
      WHERE d.origin = nullif(current_setting('app.widget_origin', true), '') AND d.status = 'VERIFIED'
        AND d.tenant_id IN (SELECT k.tenant_id FROM widget_keys k WHERE k.public_key = nullif(current_setting('app.widget_key', true), ''))))
  WITH CHECK (id = nullif(current_setting('app.tenant_id', true), '')::uuid);
