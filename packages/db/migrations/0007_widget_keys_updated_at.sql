-- Attaches the shared set_updated_at() trigger from migration 0001 (P0-25).
CREATE TRIGGER widget_keys_set_updated_at
  BEFORE UPDATE ON widget_keys
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
