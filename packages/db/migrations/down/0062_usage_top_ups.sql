-- Reverses 0062_usage_top_ups.sql.
--
-- The rows go with the table. Down is for development and a failed deploy;
-- nothing that has taken a real payment is ever migrated down.
DROP TABLE IF EXISTS "usage_top_ups";
