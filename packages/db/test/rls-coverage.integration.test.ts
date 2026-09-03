import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { RLS_POLICIES } from '../src/rls.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Every tenant-scoped table has RLS (P0-41).
 *
 * The realistic failure is not someone disabling RLS. It is someone adding a
 * table in six months who has never read this plan. This test is how that
 * person finds out, in CI, on their own PR.
 *
 * It deliberately asks the **database** rather than `RLS_POLICIES`: P0-37's own
 * tests are generated from that list, so a table missing from it is invisible to
 * them by construction. Discovery has to come from the other direction — every
 * table carrying a `tenant_id` — or the two agree with each other about a table
 * neither has heard of.
 */

/**
 * Tables with a `tenant_id` that deliberately carry no policy.
 *
 * Empty today, and that is not an oversight. `processed_webhooks` and
 * `rate_limit_buckets` are the two tables the plan exempts, and neither has a
 * `tenant_id` column at all — so neither is discovered by the query below and
 * neither needs an entry here. The list exists for the case the plan
 * anticipated but the schema has not yet produced: a table that *is* scoped by
 * tenant and still, for a stated reason, must not be isolated.
 *
 * Adding a name here is a security decision. It needs a comment saying why, and
 * a reviewer who agrees.
 */
const ALLOWLIST: ReadonlySet<string> = new Set([]);

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

/** Every public table with a `tenant_id` column, as the database sees it. */
const tenantScopedTables = async (): Promise<string[]> => {
  const rows = await db.execute(sql`
    select table_name from information_schema.columns
    where table_schema = 'public' and column_name = 'tenant_id'
    order by table_name
  `);

  return [...rows].map((row) => String((row as { table_name: unknown }).table_name));
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('rls coverage', () => {
  it('finds the tables by reflection, not from the policy list', async () => {
    // Guards the guard. If this query ever returns nothing — a typo in the
    // column name, a schema rename — every assertion below passes vacuously
    // while checking nothing at all.
    const tables = await tenantScopedTables();

    expect(tables.length).toBeGreaterThan(10);
    expect(tables).toContain('products');
  });

  it('enables and forces RLS on every tenant-scoped table', async () => {
    const tables = (await tenantScopedTables()).filter((t) => !ALLOWLIST.has(t));

    const rows = await db.execute(sql`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r'
    `);
    const state = new Map(
      [...rows].map((row) => [
        String((row as { relname: unknown }).relname),
        row as { relrowsecurity: boolean; relforcerowsecurity: boolean },
      ]),
    );

    const missing = tables.filter((t) => state.get(t)?.relrowsecurity !== true);
    const unforced = tables.filter((t) => state.get(t)?.relforcerowsecurity !== true);

    // Reported as lists rather than one table at a time, so a reviewer adding
    // three tables sees all three names in the failure instead of fixing them
    // one CI run at a time.
    expect(missing, 'tables with tenant_id and no RLS').toEqual([]);
    expect(unforced, 'tables with RLS but not FORCE').toEqual([]);
  });

  it('gives every tenant-scoped table a tenant_isolation policy', async () => {
    const tables = (await tenantScopedTables()).filter((t) => !ALLOWLIST.has(t));

    const rows = await db.execute(sql`
      select tablename from pg_policies
      where schemaname = 'public' and policyname = 'tenant_isolation'
    `);
    const policed = new Set(
      [...rows].map((row) => String((row as { tablename: unknown }).tablename)),
    );

    expect(tables.filter((t) => !policed.has(t))).toEqual([]);
  });

  it('gives every policy both a USING and a WITH CHECK', async () => {
    /*
     * A policy with only `USING` filters reads and permits any write. That is
     * the subtlest way to have RLS and not have isolation: every read test
     * passes, and a bug can still write a row into another tenant.
     *
     * `pg_policies` reports the two separately, so the absence of one is
     * visible here and nowhere else.
     */
    const rows = await db.execute(sql`
      select tablename, qual, with_check from pg_policies
      where schemaname = 'public' and policyname = 'tenant_isolation'
    `);

    const withoutUsing = [...rows]
      .filter((row) => (row as { qual: unknown }).qual === null)
      .map((row) => String((row as { tablename: unknown }).tablename));
    const withoutCheck = [...rows]
      .filter((row) => (row as { with_check: unknown }).with_check === null)
      .map((row) => String((row as { tablename: unknown }).tablename));

    expect(withoutUsing, 'policies with no USING').toEqual([]);
    expect(withoutCheck, 'policies with no WITH CHECK').toEqual([]);
  });

  it('carries no permissive second policy that would widen the first', async () => {
    /*
     * Permissive policies are OR-ed in Postgres. A second one added for a
     * plausible reason — an admin view, a debugging aid — does not modify
     * `tenant_isolation`, it bypasses it, and every existing isolation test
     * still passes because they only ever assert what one tenant can see.
     */
    const rows = await db.execute(sql`
      select tablename, policyname from pg_policies
      where schemaname = 'public' and policyname <> 'tenant_isolation'
    `);

    expect(
      [...rows].map(
        (row) =>
          `${String((row as { tablename: unknown }).tablename)}.${String((row as { policyname: unknown }).policyname)}`,
      ),
    ).toEqual([]);
  });

  it('agrees with the list P0-37 generates from', async () => {
    /*
     * The two directions meet here. Reflection finds tables with a tenant_id;
     * RLS_POLICIES is what the migration was generated from. `tenants` is in
     * the list without a tenant_id — it *is* the tenant — so it is expected on
     * one side only; anything else appearing on one side and not the other
     * means a table was added to the schema and not the list, or the reverse.
     */
    const reflected = new Set(await tenantScopedTables());
    const listed = new Set(RLS_POLICIES.map((policy) => policy.table));

    const inSchemaOnly = [...reflected].filter((t) => !listed.has(t));
    const inListOnly = [...listed].filter((t) => !reflected.has(t) && t !== 'tenants');

    expect(inSchemaOnly, 'tenant-scoped tables missing from RLS_POLICIES').toEqual([]);
    expect(inListOnly, 'RLS_POLICIES entries with no tenant_id column').toEqual([]);
  });

  it('keeps every allowlisted table genuinely exempt', async () => {
    // An allowlist entry for a table that has since gained a policy, or that
    // no longer exists, is a stale exemption nobody will notice — the entry
    // reads as deliberate long after the reason has gone.
    const tables = new Set(await tenantScopedTables());

    expect([...ALLOWLIST].filter((t) => !tables.has(t))).toEqual([]);
  });
});
