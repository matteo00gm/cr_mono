import { PostgreSqlContainer, type StartedPostgreSqlContainer } from '@testcontainers/postgresql';
import { applyBootstrap, applyMigrations, type BootstrapRole } from '@catalogorosso/db';
import { createDbClient, type Database, type DbClient } from '@catalogorosso/db/test-support';
import { sql } from 'drizzle-orm';

/**
 * Shared Postgres harness for integration suites (P0-44).
 *
 * Integration tests run against real Postgres because RLS, `halfvec`, HNSW and
 * `tsvector` cannot be faked — mocking them would test the mock. This starts a
 * container, applies bootstrap and migrations through the same module a deploy
 * uses, and hands back a connection.
 *
 * **The connection is `app_rw`, never the superuser.** That is the single most
 * important line in this file. A superuser bypasses RLS, so a harness that
 * yielded one would make every isolation test in the repo pass vacuously — the
 * suite would stay green while proving nothing, which is worse than having no
 * suite at all.
 */

/**
 * Pinned exactly, and pinned *low*.
 *
 * The floor this repo depends on is pgvector 0.7.0 (`halfvec`, asserted in
 * bootstrap). 0.8.0 is what RDS offers for Postgres 16, so a capability that
 * works here works on the deployed database. Pinning to newest inverts the
 * guarantee — the suite could pass on something RDS does not have — and a
 * floating `pg16` tag gives it up entirely by changing under a green build.
 */
export const POSTGRES_IMAGE = 'pgvector/pgvector:0.8.0-pg16';

/**
 * Fixed rather than random, so a failing run can be reproduced by connecting to
 * the container by hand. They reach bootstrap as session GUCs, the same way SSM
 * will feed the real ones — this path is not a test-only shortcut.
 */
export const ROLE_PASSWORDS: Record<BootstrapRole, string> = {
  app_migrate: 'app_migrate_test_password',
  app_rw: 'app_rw_test_password',
};

export interface TestDatabase {
  /** Connected as `app_rw`: subject to RLS, exactly as the application is. */
  readonly db: Database;
  /** Connects as the container superuser. Bypasses RLS; owns nothing. */
  readonly adminDb: Database;
  /** Connection string for one of the bootstrap roles. */
  readonly roleUrl: (role: BootstrapRole) => string;
  readonly container: StartedPostgreSqlContainer;
  readonly close: () => Promise<void>;
}

/**
 * Starts a container and brings the schema up.
 *
 * One of these per test *file*, held in `beforeAll`. Per-test containers make
 * the suite unusably slow — a container start is seconds, an assertion is
 * milliseconds — and `truncateAll` exists so tests can still start from a known
 * state without paying that cost.
 */
export const startTestDatabase = async (): Promise<TestDatabase> => {
  const container = await new PostgreSqlContainer(POSTGRES_IMAGE).start();
  const adminUrl = `${container.getConnectionUri()}?sslmode=disable`;

  const host = container.getHost();
  const port = String(container.getPort());
  const database = container.getDatabase();
  const roleUrl = (role: BootstrapRole): string =>
    `postgres://${role}:${ROLE_PASSWORDS[role]}@${host}:${port}/${database}?sslmode=disable`;

  await applyBootstrap(adminUrl, ROLE_PASSWORDS);
  await applyMigrations(roleUrl('app_migrate'));

  // `max: 1` throughout: the tenant GUC is session state, so every statement a
  // test issues has to land on the connection that set it. A pool of two turns
  // tenant context into a coin flip.
  const appClient: DbClient = createDbClient(roleUrl('app_rw'), { max: 1 });
  const adminClient: DbClient = createDbClient(adminUrl, { max: 1 });

  return {
    db: appClient.db,
    adminDb: adminClient.db,
    roleUrl,
    container,
    close: async () => {
      await appClient.close();
      await adminClient.close();
      await container.stop();
    },
  };
};

/**
 * Empties every tenant table between tests.
 *
 * `TRUNCATE ... RESTART IDENTITY CASCADE` rather than re-running migrations,
 * which would cost seconds per test for a result a single statement gives.
 *
 * Issued as the **superuser**, deliberately. `app_rw` has no TRUNCATE — P0-39
 * asserts it does not — and giving it one so the harness could tidy up would
 * hand the runtime role a way to empty a table it is not allowed to delete
 * from, defeating the append-only grants in P0-30 through P0-32.
 *
 * `drizzle.__drizzle_migrations` is untouched: truncating the ledger would make
 * the next `applyMigrations` re-run everything against a schema that already
 * has it.
 */
export const truncateAll = async (harness: TestDatabase): Promise<void> => {
  await harness.adminDb.execute(sql`
    do $$
    declare
      tables text;
    begin
      select string_agg(format('%I.%I', schemaname, tablename), ', ')
        into tables
        from pg_tables
       where schemaname = 'public';

      if tables is not null then
        execute 'truncate table ' || tables || ' restart identity cascade';
      end if;
    end
    $$;
  `);
};

/**
 * Runs `fn` against a freshly started database and always tears it down.
 *
 * For the occasional suite that wants a container to itself. Most files should
 * hold one from `beforeAll` instead and truncate between tests, because this
 * pays a container start per call.
 */
export const withTestDb = async <T>(fn: (harness: TestDatabase) => Promise<T>): Promise<T> => {
  const harness = await startTestDatabase();

  try {
    return await fn(harness);
  } finally {
    await harness.close();
  }
};
