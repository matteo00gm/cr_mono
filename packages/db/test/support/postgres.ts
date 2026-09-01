import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import postgres from 'postgres';

/**
 * Shared Postgres fixture for the integration suites (P0-20).
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

const BOOTSTRAP_DIR = join(dirname(fileURLToPath(import.meta.url)), '../../bootstrap');

/**
 * Starts a container and applies `bootstrap/`.
 *
 * The connection URI is returned rather than a client: callers need to connect
 * as different roles, and handing back one client would quietly make the
 * superuser connection the default — the mistake that made the first version of
 * the RLS suite pass while proving nothing.
 */
export const startPostgres = async (): Promise<{
  container: StartedPostgreSqlContainer;
  /** Connects as the container's superuser. Owns the schema; bypasses RLS. */
  adminUrl: string;
}> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminUrl = `${container.getConnectionUri()}?sslmode=disable`;

  await applyBootstrap(adminUrl);

  return { container, adminUrl };
};

/**
 * Applies every file in `bootstrap/`, in filename order, as the connecting role.
 *
 * Runs through postgres-js's simple protocol (`.simple()`) because these files
 * hold several statements each, and the extended protocol accepts only one per
 * round trip. That is also why bootstrap files carry no bound parameters —
 * simple queries cannot take them, which is a constraint P0-21 has to work
 * within when it injects role passwords.
 */
export const applyBootstrap = async (url: string): Promise<void> => {
  const files = (await readdir(BOOTSTRAP_DIR)).filter((f) => f.endsWith('.sql')).sort();
  const sql = postgres(url, { max: 1 });

  try {
    for (const file of files) {
      await sql.unsafe(await readFile(join(BOOTSTRAP_DIR, file), 'utf8')).simple();
    }
  } finally {
    await sql.end();
  }
};
