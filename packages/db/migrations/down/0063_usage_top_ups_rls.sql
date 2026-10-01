-- Reverses 0063_usage_top_ups_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON usage_top_ups;
ALTER TABLE usage_top_ups NO FORCE ROW LEVEL SECURITY;
ALTER TABLE usage_top_ups DISABLE ROW LEVEL SECURITY;
