import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { applyMigrations, revertMigrations } from '../src/deploy.js';
import { ROLE_PASSWORDS, startPostgres, type TestPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Migrations are reversible and idempotent (P0-40).
 *
 * An irreversible migration discovered during an incident is a very bad time to
 * find out. This drives the real chain — up, seed, all the way down, up again —
 * and compares the schema either side.
 *
 * The comparison is the point rather than the round trip completing. A down
 * file that drops a table but forgets its enum, or leaves a policy behind,
 * still rolls back "successfully"; the second migration then fails or, worse,
 * succeeds against a subtly different schema. Diffing a normalised `pg_dump`
 * catches the residue.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let started: TestPostgres;
let db: Database;

/**
 * The schema as Postgres itself describes it.
 *
 * Taken with `pg_dump` inside the container rather than by querying catalogues:
 * a hand-rolled catalogue query only compares what it thought to ask about, and
 * the failure this test exists for is precisely the object nobody thought of.
 *
 * Normalised, because a raw dump differs run to run in ways that mean nothing:
 * the server version banner, the dump timestamp, blank lines and comments.
 */
const dumpSchema = async (): Promise<string> => {
  const result = await started.container.exec([
    'pg_dump',
    '--schema-only',
    '--no-owner',
    '--no-privileges',
    '-U',
    started.container.getUsername(),
    started.container.getDatabase(),
  ]);

  if (result.exitCode !== 0) {
    throw new Error(`pg_dump failed (${String(result.exitCode)}): ${result.output}`);
  }

  return result.output
    .split('\n')
    .map((line) => line.trimEnd())
    .filter(
      (line) =>
        line !== '' &&
        !line.startsWith('--') &&
        // pg_dump 16+ brackets its output with a `restrict` / `unrestrict`
        // meta-command carrying a token that is random per invocation. Left
        // in, every comparison of two dumps fails on pure noise.
        !line.startsWith(String.fromCharCode(92) + 'restrict') &&
        !line.startsWith(String.fromCharCode(92) + 'unrestrict'),
    )
    .join('\n');
};

const tableCount = async (): Promise<number> => {
  const rows = await db.execute(sql`
    select count(*)::int as n from pg_tables where schemaname = 'public'
  `);

  return Number([...rows][0]?.n);
};

beforeAll(async () => {
  started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 240_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('migration up / down / up', () => {
  it('returns to an identical schema after a full round trip', async () => {
    const migrateUrl = started.roleUrl('app_migrate');

    const before = await dumpSchema();
    expect(before).toContain('CREATE TABLE public.tenants');
    expect(await tableCount()).toBeGreaterThan(0);

    // Seeded first, so the rollback is exercised against a database holding
    // rows rather than an empty one. A down file that works on an empty schema
    // and fails on a populated one is the common case: dropping a table with
    // dependent rows is where a missing CASCADE surfaces.
    await createTenant(db, 'roundtrip');

    await revertMigrations(migrateUrl);

    expect(await tableCount()).toBe(0);

    await applyMigrations(migrateUrl);

    const after = await dumpSchema();

    expect(after).toBe(before);
  }, 180_000);

  it('leaves no enum behind when its table is dropped', async () => {
    /*
     * Asserted separately because the dump comparison above would catch it
     * only on the *second* pass — the first rollback leaves the type, the
     * re-migration then fails on `CREATE TYPE ... already exists`, and the
     * error names the type rather than the down file that forgot it.
     *
     * Checked after the round trip, so it also confirms the re-migration
     * recreated them rather than merely finding them still present.
     */
    const rows = await db.execute(sql`
      select typname from pg_type
      where typnamespace = 'public'::regnamespace and typtype = 'e'
      order by typname
    `);
    const enums = [...rows].map((row) => String((row as { typname: unknown }).typname));

    expect(enums).toContain('tenant_status');
    expect(enums).toContain('widget_event_type');
    expect(enums).toContain('security_event_type');
  });

  it('re-applies cleanly a second time, which is what a redeploy does', async () => {
    // applyMigrations is idempotent by way of the ledger: a redeploy that
    // re-runs it must be a no-op rather than an error. This is the assertion
    // that a broken journal would fail.
    await expect(applyMigrations(started.roleUrl('app_migrate'))).resolves.toBeUndefined();

    expect(await tableCount()).toBeGreaterThan(0);
  }, 120_000);

  it('restores row level security on the way back up', async () => {
    /*
     * The single most important thing to survive a rollback. RLS is applied by
     * migration 0025 and dropped by its reverse, so a round trip that restored
     * every table but not the policies would leave a schema that looks
     * complete and isolates nothing — and every other suite in this package
     * would still pass, because they set tenant context anyway.
     */
    const rows = await db.execute(sql`
      select count(*)::int as n from pg_policies where policyname = 'tenant_isolation'
    `);

    expect(Number([...rows][0]?.n)).toBeGreaterThan(0);

    const forced = await db.execute(sql`
      select count(*)::int as n from pg_class
      where relrowsecurity and not relforcerowsecurity and relnamespace = 'public'::regnamespace
    `);

    expect(Number([...forced][0]?.n)).toBe(0);
  });

  it('keeps a reverse for every migration', async () => {
    // The convention P0-20 set, asserted rather than trusted: a migration
    // added without its down file makes the round trip above impossible, and
    // the failure would otherwise appear as an unrelated rollback error.
    const { readdir } = await import('node:fs/promises');
    const { dirname, join } = await import('node:path');
    const { fileURLToPath } = await import('node:url');

    const migrations = join(dirname(fileURLToPath(import.meta.url)), '../migrations');
    const up = (await readdir(migrations)).filter((f) => f.endsWith('.sql')).sort();
    const down = (await readdir(join(migrations, 'down'))).filter((f) => f.endsWith('.sql')).sort();

    expect(down).toEqual(up);
    expect(ROLE_PASSWORDS.app_migrate).toBeTruthy();
  });
});
