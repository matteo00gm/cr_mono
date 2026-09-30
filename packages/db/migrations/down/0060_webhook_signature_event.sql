-- Reverses 0060_webhook_signature_event.sql.

-- Postgres cannot drop an enum value, so the type is rebuilt without it, on
-- 0044's pattern. Rows carrying INVALID_WEBHOOK_SIGNATURE have no
-- representation in the older type and go with it; this runs as app_migrate,
-- which owns the table, so P0-31's revoke on app_rw is untouched.
DELETE FROM security_events WHERE type = 'INVALID_WEBHOOK_SIGNATURE';
ALTER TABLE security_events ALTER COLUMN type TYPE text;
DROP TYPE security_event_type;
CREATE TYPE security_event_type AS ENUM('UNAUTHORIZED_ORIGIN', 'INVALID_KEY', 'TOKEN_ORIGIN_MISMATCH', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'REPLAYED_WEBHOOK', 'INVALID_TOKEN');
ALTER TABLE security_events ALTER COLUMN type TYPE security_event_type USING type::security_event_type;
