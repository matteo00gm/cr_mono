-- Reverses 0040_import_runs_rls.sql.

DROP POLICY IF EXISTS tenant_isolation ON import_runs;
ALTER TABLE import_runs NO FORCE ROW LEVEL SECURITY;
ALTER TABLE import_runs DISABLE ROW LEVEL SECURITY;
