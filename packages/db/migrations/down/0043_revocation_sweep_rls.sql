-- Reverses 0043_revocation_sweep_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON token_revocations;
CREATE POLICY tenant_isolation ON token_revocations
  USING (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid)
  WITH CHECK (tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid);
