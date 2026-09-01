-- Attaches the shared set_updated_at() trigger from migration 0001 (P0-23).
--
-- One CREATE TRIGGER per table, by design: the alternative is an event trigger
-- that attaches itself to anything with the column, which is clever in the way
-- that makes a schema hard to read and impossible to grep.
CREATE TRIGGER memberships_set_updated_at
  BEFORE UPDATE ON memberships
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
