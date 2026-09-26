-- Reverses 0047_session_cutoffs_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON widget_session_cutoffs;
ALTER TABLE widget_session_cutoffs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE widget_session_cutoffs DISABLE ROW LEVEL SECURITY;
