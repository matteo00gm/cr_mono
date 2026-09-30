-- Reverses 0056_domain_claim_sweep_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON domain_claims;
CREATE POLICY tenant_isolation ON domain_claims
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR incumbent_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (incumbent_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid AND status = 'CANCELED'));

DROP POLICY IF EXISTS tenant_isolation ON tenant_domains;
CREATE POLICY tenant_isolation ON tenant_domains
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    OR (origin = nullif(current_setting('app.widget_origin', true), '')
      AND tenant_id IN (SELECT k.tenant_id FROM widget_keys k WHERE k.public_key = nullif(current_setting('app.widget_key', true), '')))
    OR origin IN (SELECT c.origin FROM domain_claims c
      WHERE c.id = nullif(current_setting('app.domain_claim', true), '')::uuid
        AND (c.status = 'PROVEN'
          OR (c.status = 'NOTICE' AND c.transfer_at <= now()))))
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
