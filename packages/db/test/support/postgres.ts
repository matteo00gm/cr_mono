import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';

import { applyBootstrap, applyMigrations, type BootstrapRole } from '../../src/deploy.js';

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
export const ROLE_PASSWORDS: Record<BootstrapRole, string> = {
  app_migrate: 'app_migrate_test_password',
  app_rw: 'app_rw_test_password',
};

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
 * Both steps come from `src/deploy.ts` — the module a deploy uses — rather
 * than from a copy living here. When the two were separate, these suites could
 * prove the SQL correct while the deploy path stayed broken, which is exactly
 * what happened with the P0-21 `CREATE SCHEMA` grant.
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

  await applyBootstrap(adminUrl, ROLE_PASSWORDS);
  await applyMigrations(roleUrl('app_migrate'));

  return { container, adminUrl, roleUrl };
};
