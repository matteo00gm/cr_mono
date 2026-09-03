import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Applying `bootstrap/` and `migrations/` to a database (P0-21b).
 *
 * This module is the deploy-time path, and it is deliberately the *same* code
 * the integration fixture uses. The alternative — a deploy script that
 * re-implements what the tests do — is how the P0-21 grant bug survived: the
 * suites proved the SQL was right while nothing proved the migrator could
 * actually run as `app_migrate`. One implementation means the tests exercise
 * what a deploy will do.
 *
 * It opens connections outside `withTenant`, which the P0-09 boundary rule
 * otherwise forbids. That exemption is narrow and reasoned: this is DDL, run
 * by roles that own the schema, before any tenant exists. There is no tenant
 * context to carry and no policy for one to satisfy.
 */

/** Roles whose passwords `bootstrap/0001_roles.sql` expects as session GUCs. */
export type BootstrapRole = 'app_rw' | 'app_migrate';

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '..');
const BOOTSTRAP_DIR = join(PACKAGE_DIR, 'bootstrap');
const MIGRATIONS_DIR = join(PACKAGE_DIR, 'migrations');
const DOWN_DIR = join(MIGRATIONS_DIR, 'down');

/**
 * Rewrites a connection URL to connect as a different role.
 *
 * The deploy path is handed one URL — the master credentials — and needs a
 * second one for `app_migrate` against the same host, port and database.
 * Deriving it beats passing two URLs that could disagree about which database
 * they point at, which is a mistake nothing downstream would catch: migrations
 * would simply be applied somewhere else and report success.
 *
 * `URL` does the encoding. Building this with string concatenation is how a
 * password containing a reserved character silently produces a URL pointing at
 * the wrong host.
 */
export const withRole = (url: string, role: string, password: string): string => {
  const parsed = new URL(url);

  parsed.username = encodeURIComponent(role);
  parsed.password = encodeURIComponent(password);

  return parsed.toString();
};

/*
 * The two functions below are excluded from coverage, deliberately and
 * narrowly.
 *
 * Neither can be unit-tested: each exists to drive a real Postgres, and a test
 * that mocked the driver would assert that this file calls the functions it
 * visibly calls. They are covered instead by the eleven integration suites,
 * every one of which reaches the database through them — but `vitest run
 * --coverage` measures the unit run only, so that evidence never reaches the
 * report and would drag `packages/db` under its bar.
 *
 * Scoped to these two functions rather than the file, so `withRole` — the part
 * with logic worth checking, and the part with its own spec — keeps counting.
 * Written here rather than as an exclusion in `vitest.config.ts` so the reason
 * is visible to whoever next reads the code, not buried in configuration.
 */
/* v8 ignore start */

/**
 * Applies every file in `bootstrap/`, in filename order, as the connecting role.
 *
 * Role passwords go in as session GUCs through a bound parameter, never
 * interpolated into the SQL — the same shape the deployed bootstrap uses with
 * values read from SSM, so this path is not a test-only shortcut. A literal
 * would also be written verbatim to the server log under `log_statement = 'ddl'`.
 *
 * `max: 1` is what makes that work: the GUCs are session state, so the files
 * have to run on the same connection that set them.
 *
 * The files run through postgres-js's simple protocol (`.simple()`) because
 * each holds several statements and the extended protocol accepts only one per
 * round trip. Simple queries cannot carry bound parameters, which is precisely
 * why the passwords arrive as GUCs instead.
 */
export const applyBootstrap = async (
  url: string,
  passwords: Record<BootstrapRole, string>,
): Promise<void> => {
  const files = (await readdir(BOOTSTRAP_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const sql = postgres(url, { max: 1 });

  try {
    for (const [role, password] of Object.entries(passwords)) {
      await sql`select set_config(${`bootstrap.${role}_password`}, ${password}, false)`;
    }

    for (const file of files) {
      await sql.unsafe(await readFile(join(BOOTSTRAP_DIR, file), 'utf8')).simple();
    }
  } finally {
    await sql.end();
  }
};

/**
 * Runs the migration chain through Drizzle's own migrator.
 *
 * The real path, not a re-implementation: it reads `meta/_journal.json` and
 * records what it applied, so a broken journal fails here rather than on a
 * deploy. Call it as `app_migrate` — whoever runs a migration owns the tables
 * it creates, and everything about tenant isolation depends on that owner not
 * being `app_rw`.
 */
export const applyMigrations = async (url: string): Promise<void> => {
  const sql = postgres(url, { max: 1 });

  try {
    await migrate(drizzle({ client: sql }), { migrationsFolder: MIGRATIONS_DIR });
  } finally {
    await sql.end();
  }
};

/**
 * Rolls the migration chain back to zero, newest first (P0-40).
 *
 * Every migration carries a hand-written reverse under `migrations/down/` with
 * the same filename, and this applies them in descending order — the only
 * order in which they can work, since a table cannot be dropped before the
 * grants and policies that reference it.
 *
 * The ledger is emptied afterwards rather than row by row. Drizzle's migrator
 * decides what to apply by comparing timestamps against what it finds there,
 * so a ledger still claiming migrations that no longer exist in the database
 * means the next `applyMigrations` silently applies nothing — which looks
 * exactly like success and leaves an empty schema.
 *
 * Used by P0-40's reversibility test. It is deliberately here rather than in
 * the test: an irreversible migration discovered during an incident is a very
 * bad time to find out that the rollback path was only ever test code.
 */
export const revertMigrations = async (url: string): Promise<void> => {
  const files = (await readdir(DOWN_DIR))
    .filter((f) => f.endsWith('.sql'))
    .sort()
    .reverse();
  const sql = postgres(url, { max: 1 });

  try {
    for (const file of files) {
      await sql.unsafe(await readFile(join(DOWN_DIR, file), 'utf8')).simple();
    }

    await sql.unsafe('delete from drizzle.__drizzle_migrations').simple();
  } finally {
    await sql.end();
  }
};

/* v8 ignore stop */
