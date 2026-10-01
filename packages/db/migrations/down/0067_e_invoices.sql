-- Reverses 0067_e_invoices.sql.
--
-- The charges go with the table. Down is for development and a failed deploy;
-- a stage that has taken real payments is not migrated down past this.
DROP TABLE IF EXISTS "e_invoices";
