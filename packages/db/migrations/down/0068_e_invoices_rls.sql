-- Reverses 0068_e_invoices_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON e_invoices;
ALTER TABLE e_invoices NO FORCE ROW LEVEL SECURITY;
ALTER TABLE e_invoices DISABLE ROW LEVEL SECURITY;
