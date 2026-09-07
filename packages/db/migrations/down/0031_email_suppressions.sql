-- Reverses 0031_email_suppressions.sql.
--
-- The index goes with the table; naming it separately would fail on the second
-- run of a rollback that already dropped the table.
DROP TABLE IF EXISTS "email_suppressions";
