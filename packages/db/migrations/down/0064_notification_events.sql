-- Reverses 0064_notification_events.sql.
--
-- The record of which notices went out goes with the table; migrated up again,
-- a month already notified would be notified once more.
DROP TABLE IF EXISTS "notification_events";
