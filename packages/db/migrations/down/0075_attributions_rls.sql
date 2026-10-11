-- Reverses 0075_attributions_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON attributions;
ALTER TABLE attributions NO FORCE ROW LEVEL SECURITY;
ALTER TABLE attributions DISABLE ROW LEVEL SECURITY;
