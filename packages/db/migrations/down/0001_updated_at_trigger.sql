-- Reverses 0001_updated_at_trigger.sql.
DROP TRIGGER IF EXISTS tenants_set_updated_at ON tenants;

DROP FUNCTION IF EXISTS set_updated_at();
