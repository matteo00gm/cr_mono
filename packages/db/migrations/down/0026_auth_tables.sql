-- Reverses 0026_auth_tables.sql.
--
-- Dependants first: sessions, accounts and two-factor rows all reference
-- auth_users, so the parent cannot go until they have.
DROP TABLE IF EXISTS "auth_two_factor";

DROP TABLE IF EXISTS "auth_accounts";

DROP TABLE IF EXISTS "auth_sessions";

DROP TABLE IF EXISTS "auth_verifications";

DROP TABLE IF EXISTS "auth_users";
