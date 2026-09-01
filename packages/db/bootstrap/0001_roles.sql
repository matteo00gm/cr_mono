-- Database roles (P0-21).
--
-- RLS is bypassed by a superuser, by BYPASSRLS, and — the one that catches
-- people — by the table's owner unless FORCE ROW LEVEL SECURITY is set. If the
-- application connects as any of those, every policy written in P0-37 is
-- decoration. This file is what makes the separation real:
--
--   app_migrate  owns the tables. Runs migrations. Never used by the app.
--   app_rw       the runtime role. DML only, no DDL, not an owner.
--   app_admin    break-glass. No password, so it cannot be used by accident.
--
-- Bootstrap, not a migration: CREATE ROLE needs privileges app_migrate does not
-- have, and app_migrate is created here, so it cannot create itself.
--
-- Passwords arrive as GUCs set by the caller rather than as literals in this
-- file. Two reasons, and the second is the one that matters: a literal here is
-- a secret in git, and a plain `CREATE ROLE ... PASSWORD 'x'` is written to the
-- server log verbatim under log_statement = 'ddl'. A statement built inside
-- EXECUTE is not logged at all, so the password reaches the server and stops
-- there.

-- Every role is created the same way: build the statement dynamically so the
-- password never appears in a logged statement, and treat an existing role as a
-- password rotation rather than an error, so bootstrap stays re-runnable.
DO $$
DECLARE
  password text := current_setting('bootstrap.app_migrate_password');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_migrate') THEN
    EXECUTE format('ALTER ROLE app_migrate WITH PASSWORD %L', password);
  ELSE
    EXECUTE format(
      'CREATE ROLE app_migrate LOGIN PASSWORD %L
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      password);
  END IF;
END
$$;

DO $$
DECLARE
  password text := current_setting('bootstrap.app_rw_password');
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rw') THEN
    EXECUTE format('ALTER ROLE app_rw WITH PASSWORD %L', password);
  ELSE
    EXECUTE format(
      'CREATE ROLE app_rw LOGIN PASSWORD %L
         NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE NOINHERIT',
      password);
  END IF;
END
$$;

-- Break-glass, deliberately NOLOGIN.
--
-- BYPASSRLS is exactly the power an incident needs — reading across tenants to
-- see what happened — and exactly the power that must not sit behind a password
-- in a parameter store, where any process that can read SSM inherits it. With
-- no password the role cannot be connected to at all; using it means a human
-- with master access grants it or sets a password deliberately, and that act is
-- itself the audit trail. P0-39 asserts it cannot log in.
DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_admin') THEN
    CREATE ROLE app_admin NOLOGIN BYPASSRLS NOSUPERUSER NOCREATEDB NOCREATEROLE;
  END IF;
END
$$;

-- Nothing is reachable by default.
--
-- PUBLIC is every role, present and future. Postgres 15 removed PUBLIC's CREATE
-- on the public schema but left USAGE, so without this revoke a role created
-- later for some unrelated purpose can still read whatever is granted to PUBLIC.
REVOKE ALL ON SCHEMA public FROM PUBLIC;

GRANT USAGE ON SCHEMA public TO app_rw, app_migrate;

-- CREATE is the DDL privilege, and only the migration role gets it. This is the
-- line that stops app_rw from being able to create a table it would then own —
-- ownership being the quiet way around FORCE ROW LEVEL SECURITY.
GRANT CREATE ON SCHEMA public TO app_migrate;

-- The runtime grant, applied to whatever app_migrate creates from now on.
--
-- ALTER DEFAULT PRIVILEGES only affects future objects, which is why it belongs
-- here, before the first table migration rather than after it. FOR ROLE
-- app_migrate is load-bearing: default privileges attach to the creating role,
-- so without it this would describe tables created by the master role instead —
-- and silently grant nothing.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO app_rw;

-- Sequences, for any table that ends up with an identity column. None do today;
-- omitting it means the first one that does fails at runtime with a permission
-- error that reads as a bug in the feature rather than a gap here.
ALTER DEFAULT PRIVILEGES FOR ROLE app_migrate IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO app_rw;

-- The migration ledger's home, created here because app_migrate cannot make it.
--
-- Drizzle's migrator records applied migrations in a `drizzle` schema and will
-- try to create it on first run. Creating a schema needs CREATE on the
-- *database*, which app_migrate does not have and should not be given — that
-- privilege is "make any schema you like", far wider than "own this one". So
-- the schema is created here with app_migrate as its owner, and the migrator
-- finds it already present.
--
-- app_rw is given no USAGE on it, so the runtime role cannot read the migration
-- history, let alone rewrite it. That matters more than it looks: the ledger is
-- what decides whether a migration is re-applied.
CREATE SCHEMA IF NOT EXISTS drizzle AUTHORIZATION app_migrate;

REVOKE ALL ON SCHEMA drizzle FROM PUBLIC;

-- Note for P0-31: audit_log must not be UPDATE- or DELETE-able by app_rw. The
-- default above grants all four, so that migration has to revoke the two it
-- does not want. Append-only is a property of the grant, not of intent.
