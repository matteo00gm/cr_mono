-- Reverses 0000_tenants.sql.
--
-- Types are dropped after the table that uses them; the reverse order fails
-- with a dependency error, which is the correct behaviour and the reason this
-- file is written by hand rather than derived.
DROP TABLE IF EXISTS "tenants";

DROP TYPE IF EXISTS "tenant_plan";

DROP TYPE IF EXISTS "tenant_status";
