-- Attaches the shared set_updated_at() trigger from migration 0001 (P0-24).
CREATE TRIGGER tenant_domains_set_updated_at
  BEFORE UPDATE ON tenant_domains
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
