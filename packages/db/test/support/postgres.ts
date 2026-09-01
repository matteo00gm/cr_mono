import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';

/**
 * Shared Postgres fixture for the integration suites (P0-20, P0-21).
 *
 * Promoted to `packages/testing` by P0-44; it lives here while `packages/db` is
 * the only consumer, because a shared helper with one caller is harder to read
 * than the thing it wraps.
 */

/**
 * Pinned exactly, and pinned *low*.
 *
 * The floor this repo depends on is pgvector 0.7.0 (halfvec, asserted in
 * bootstrap/0000). 0.8.0 is the version RDS offers for Postgres 16, so testing
 * against it means a feature that works in CI works on the deployed database.
 * Pinning to the newest release instead would invert that: the suite could pass
 * on a capability RDS does not have yet, and the failure would land in
 * production rather than in CI. A floating `pg16` tag gives up the guarantee
 * altogether by changing underneath a green build.
 */
export const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.0-pg16';

/**
 * Test-only role passwords, fed to bootstrap the same way SSM will feed the
 * real ones. Fixed rather than random so a failing run can be reproduced by
 * connecting to the container by hand.
 */
export const ROLE_PASSWORDS = {
  app_migrate: 'app_migrate_test_password',
  app_rw: 'app_rw_test_password',
} as const;

export type BootstrapRole = keyof typeof ROLE_PASSWORDS;

const PACKAGE_DIR = join(dirname(fileURLToPath(import.meta.url)), '../..');
const BOOTSTRAP_DIR = join(PACKAGE_DIR, 'bootstrap');
const MIGRATIONS_DIR = join(PACKAGE_DIR, 'migrations');

export interface TestPostgres {
  readonly container: StartedPostgreSqlContainer;
  /** Connects as the container's superuser. Owns nothing; bypasses RLS. */
  readonly adminUrl: string;
  /** Connection string for one of the bootstrap roles. */
  readonly roleUrl: (role: BootstrapRole) => string;
}

/**
 * Starts a container, applies `bootstrap/`, then runs the migrations.
 *
 * Returns connection strings rather than a client: suites need to connect as
 * different roles, and handing back one client would quietly make the superuser
 * connection the default — the mistake that made the first version of the RLS
 * suite pass while proving nothing.
 */
export const startPostgres = async (): Promise<TestPostgres> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminUrl = `${container.getConnectionUri()}?sslmode=disable`;

  const host = container.getHost();
  const port = String(container.getPort());
  const database = container.getDatabase();
  const roleUrl = (role: BootstrapRole) =>
    `postgres://${role}:${ROLE_PASSWORDS[role]}@${host}:${port}/${database}?sslmode=disable`;

  await applyBootstrap(adminUrl);
  await applyMigrations(roleUrl('app_migrate'));

  return { container, adminUrl, roleUrl };
};

/**
 * Applies every file in `bootstrap/`, in filename order, as the connecting role.
 *
 * Role passwords go in as session GUCs through a bound parameter, never
 * interpolated into the SQL — the same shape the deployed bootstrap will use
 * with values read from SSM, so this path is not a test-only shortcut.
 *
 * `max: 1` is what makes that work: the GUCs are session state, so the files
 * have to run on the same connection that set them.
 *
 * The files themselves run through postgres-js's simple protocol (`.simple()`)
 * because each holds several statements, and the extended protocol accepts only
 * one per round trip. Simple queries cannot carry bound parameters, which is
 * precisely why the passwords arrive as GUCs instead.
 */
export const applyBootstrap = async (
  url: string,
  passwords: Record<BootstrapRole, string> = ROLE_PASSWORDS,
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
