-- Reverses 0001_roles.sql.
--
-- Destructive by nature: DROP OWNED BY removes every object app_migrate owns,
-- which is every table in the database. In a full rollback the table migrations
-- have already run their own down files, so by the time this executes there is
-- nothing left to lose — it is only clearing grants and default privileges,
-- which are themselves owned by the roles and go with them. Run on its own,
-- against a database that still holds data, it will take the schema with it.
--
-- No CASCADE, deliberately: a dependency this does not know about should abort
-- the rollback rather than be quietly destroyed.
DROP SCHEMA IF EXISTS drizzle CASCADE;

DROP OWNED BY app_rw, app_migrate, app_admin;

DROP ROLE IF EXISTS app_rw;
DROP ROLE IF EXISTS app_migrate;
DROP ROLE IF EXISTS app_admin;
