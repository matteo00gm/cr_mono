import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { RLS_POLICIES } from '../src/rls.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, clearTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Row-level security, as the database actually holds it (P0-37).
 *
 * `rls.test.ts` proves the SQL matches the list. This proves the migration
 * reached the database — a distinction that matters, because a migration can
 * be generated correctly and never applied, and every other suite would still
 * pass while isolation was absent.
 *
 * Exhaustive isolation per table is P0-38; discovering tables the list forgot
 * is P0-41. What is here is the smoke that the mechanism is on.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

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

describe('row-level security', () => {
  it('is enabled and forced on every table in the list', async () => {
    /*
     * FORCE is the half that is easy to lose. Without it the table owner
     * bypasses the policy, and app_migrate owns every one of these — so a
     * migration that enabled without forcing would look right in review and
     * leave the deploy-time role reading across tenants.
     */
    // `string_to_array` rather than binding a JS array: drizzle expands
    // `${[a, b]}` into a row constructor, which Postgres rejects here with
    // "op ANY/ALL (array) requires array on right side".
    const names = RLS_POLICIES.map((policy) => policy.table).join(',');
    const rows = await db.execute(sql`
      select relname, relrowsecurity, relforcerowsecurity
      from pg_class where relname = any(string_to_array(${names}, ','))
    `);
    const state = new Map(
      [...rows].map((r) => [
        String((r as { relname: unknown }).relname),
        r as { relrowsecurity: boolean; relforcerowsecurity: boolean },
      ]),
    );

    expect(state.size).toBe(RLS_POLICIES.length);
    for (const { table } of RLS_POLICIES) {
      expect(state.get(table)?.relrowsecurity, `${table} enabled`).toBe(true);
      expect(state.get(table)?.relforcerowsecurity, `${table} forced`).toBe(true);
    }
  });

  it('gives every one of them a tenant_isolation policy', async () => {
    const rows = await db.execute(sql`
      select tablename from pg_policies where policyname = 'tenant_isolation'
    `);
    const tables = [...rows].map((r) => String((r as { tablename: unknown }).tablename)).sort();

    expect(tables).toEqual(RLS_POLICIES.map((p) => p.table).sort());
  });

  it('returns nothing at all when no tenant context is set', async () => {
    // Failing closed is the whole design. A query outside withTenant must see
    // zero rows rather than everything — and must not raise, which is what the
    // nullif around the GUC read is for.
    const tenantId = await createTenant(db, 'closed');
    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type)
      values (${tenantId}::uuid, 's', 'WIDGET_OPEN')
    `);

    await clearTenant(db);
    const rows = await db.execute(sql`select 1 from widget_events`);

    expect([...rows]).toHaveLength(0);
  });

  it('hides one tenant\u2019s rows from another', async () => {
    const first = await createTenant(db, 'iso-one');
    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, type)
      values (${first}::uuid, 'first-session', 'WIDGET_OPEN')
    `);

    // Scoping to a second tenant; its id is not needed, only its context.
    await createTenant(db, 'iso-two');
    const asSecond = await db.execute(
      sql`select 1 from widget_events where session_id = 'first-session'`,
    );

    expect([...asSecond]).toHaveLength(0);

    await useTenant(db, first);
    const asFirst = await db.execute(
      sql`select 1 from widget_events where session_id = 'first-session'`,
    );

    expect([...asFirst]).toHaveLength(1);
  });

  it('refuses a write carrying another tenant\u2019s id', async () => {
    // WITH CHECK, not USING. Without it a bug could insert a row belonging to
    // someone else and never notice, because reading it back would filter it
    // out — the write would look like it worked.
    const first = await createTenant(db, 'check-one');

    // Now scoped elsewhere; only the context matters, not this tenant's id.
    await createTenant(db, 'check-two');

    const error = await db
      .execute(
        sql`
        insert into widget_events (tenant_id, session_id, type)
        values (${first}::uuid, 's', 'WIDGET_OPEN')
      `,
      )
      .catch((caught: unknown) => caught);

    expect((error as { cause?: { code?: string } }).cause?.code).toBe('42501');
  });
});
