-- Reverses 0073_shopify_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON shopify_installations;
ALTER TABLE shopify_installations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE shopify_installations DISABLE ROW LEVEL SECURITY;

DROP POLICY IF EXISTS tenant_isolation ON shopify_oauth_states;
ALTER TABLE shopify_oauth_states NO FORCE ROW LEVEL SECURITY;
ALTER TABLE shopify_oauth_states DISABLE ROW LEVEL SECURITY;
