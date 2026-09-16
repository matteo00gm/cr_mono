-- Reverses 0044_security_event_token_type.sql.

ALTER TABLE "security_events" DROP COLUMN "ip_bucket";
ALTER TABLE "security_events" ADD COLUMN "ip" inet;

-- Postgres cannot drop an enum value, so the type is rebuilt without it. Rows
-- carrying INVALID_TOKEN have no representation in the older type and go with
-- it; this runs as app_migrate, which owns the table, so P0-31's revoke on
-- app_rw is untouched and the ledger stays append-only for the runtime role.
DELETE FROM security_events WHERE type = 'INVALID_TOKEN';
ALTER TABLE security_events ALTER COLUMN type TYPE text;
DROP TYPE security_event_type;
CREATE TYPE security_event_type AS ENUM('UNAUTHORIZED_ORIGIN', 'INVALID_KEY', 'TOKEN_ORIGIN_MISMATCH', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'REPLAYED_WEBHOOK');
ALTER TABLE security_events ALTER COLUMN type TYPE security_event_type USING type::security_event_type;
