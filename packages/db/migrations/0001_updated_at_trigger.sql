-- `updated_at`, maintained by the database (P0-22).
--
-- Every table in this schema carries `updated_at`, and the obvious place to set
-- it is the application. That is the version that goes wrong: a backfill in a
-- migration, a correction applied with psql, or any statement that does not go
-- through Drizzle leaves the column holding an older time than the row it
-- describes. A timestamp that is right most of the time is worse than no
-- timestamp, because it gets trusted — by the outbox, by analytics, and by
-- whoever is reading rows during an incident.
--
-- One function, reused by a trigger per table, so adding a table is one
-- CREATE TRIGGER rather than a decision to make again.
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
-- `now()` is the transaction's start time, not the statement's, so every row
-- touched by one transaction gets the same stamp. That is the behaviour worth
-- having: it makes "changed together" visible.
CREATE TRIGGER tenants_set_updated_at
  BEFORE UPDATE ON tenants
  FOR EACH ROW
  EXECUTE FUNCTION set_updated_at();
