-- Attaches the shared set_updated_at() trigger from migration 0001 (P0-26).
CREATE TRIGGER products_set_updated_at
  BEFORE UPDATE ON products
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
