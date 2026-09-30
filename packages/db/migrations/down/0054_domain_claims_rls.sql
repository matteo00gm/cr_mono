-- Reverses 0054_domain_claims_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON domain_claims;
ALTER TABLE domain_claims NO FORCE ROW LEVEL SECURITY;
ALTER TABLE domain_claims DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON tenant_domains;
CREATE POLICY tenant_isolation ON tenant_domains
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (origin = nullif(current_setting('app.widget_origin', true), '')
      AND tenant_id IN (SELECT k.tenant_id FROM widget_keys k WHERE k.public_key = nullif(current_setting('app.widget_key', true), ''))))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
