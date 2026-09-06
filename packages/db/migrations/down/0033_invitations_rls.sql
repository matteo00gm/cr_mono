-- Reverses 0033_invitations_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON invitations;
ALTER TABLE invitations NO FORCE ROW LEVEL SECURITY;
ALTER TABLE invitations DISABLE ROW LEVEL SECURITY;
