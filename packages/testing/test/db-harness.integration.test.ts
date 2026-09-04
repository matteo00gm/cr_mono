import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  startTestDatabase,
  truncateAll,
  withTestDb,
  type TestDatabase,
} from '../src/db-harness.js';
import { makeProduct, makeTenant } from '../src/factories.js';

/**
 * The harness connects as a role that cannot defeat RLS (P0-44).
 *
 * This is the smoke test the whole test strategy rests on. If the harness ever
 * hands back a superuser connection, every isolation assertion in the repo
 * passes vacuously — the suite stays green while proving nothing, which is a
 * worse position than having no suite, because it is believed.
 */

let harness: TestDatabase;

beforeAll(async () => {
  harness = await startTestDatabase();
}, 240_000);

afterAll(async () => {
  await harness.close();
}, 60_000);

describe('the harness connection', () => {
  it('is not a superuser and cannot bypass RLS', async () => {
    const rows = await harness.db.execute(sql`
      select current_user as role, rolsuper, rolbypassrls
      from pg_roles where rolname = current_user
    `);
    const role = [...rows][0];

    expect(role?.role).toBe('app_rw');
    expect(role?.rolsuper).toBe(false);
    expect(role?.rolbypassrls).toBe(false);
  });

  it('has RLS in force on the migrated tables', async () => {
    // Enabled is not enough: without FORCE the owner bypasses the policy, and
    // a harness that only checked `relrowsecurity` would miss it.
    const rows = await harness.db.execute(sql`
      select count(*)::int as n from pg_class
      where relnamespace = 'public'::regnamespace
        and relrowsecurity and not relforcerowsecurity
    `);

    expect(Number([...rows][0]?.n)).toBe(0);
  });

  it('sees nothing at all with no tenant context', async () => {
    // The property every other suite depends on. A harness whose connection
    // read across tenants would make the isolation matrix meaningless.
    const tenant = makeTenant();

    await harness.adminDb.execute(sql`
      insert into tenants (id, name, slug) values (${tenant.id}, ${tenant.name}, ${tenant.slug})
    `);

    const visible = await harness.db.execute(sql`select count(*)::int as n from tenants`);

    expect(Number([...visible][0]?.n)).toBe(0);
  });
});

describe('truncateAll', () => {
  it('empties the tables between tests without re-migrating', async () => {
    const tenant = makeTenant();

    await harness.db.execute(sql`select set_config('app.tenant_id', ${tenant.id}, false)`);
    await harness.db.execute(sql`
      insert into tenants (id, name, slug) values (${tenant.id}, ${tenant.name}, ${tenant.slug})
    `);
    const product = makeProduct();
    await harness.db.execute(sql`
      insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
      values (${tenant.id}, ${product.sku}, ${product.name}, ${product.wineType},
              ${product.priceCents}, ${product.currency}, ${product.stockStatus})
    `);

    await truncateAll(harness);

    const remaining = await harness.adminDb.execute(sql`
      select (select count(*) from tenants) + (select count(*) from products) as n
    `);

    expect(Number([...remaining][0]?.n)).toBe(0);
  });

  it('leaves the schema and its policies intact', async () => {
    /*
     * The distinction that makes truncation the right tool: it removes rows,
     * not structure. Re-migrating between tests would cost seconds each and
     * achieve the same thing; dropping tables would achieve something else
     * entirely and only fail several tests later.
     */
    await truncateAll(harness);

    const rows = await harness.db.execute(sql`
      select count(*)::int as n from pg_policies
      where schemaname = 'public' and policyname = 'tenant_isolation'
    `);

    expect(Number([...rows][0]?.n)).toBeGreaterThan(0);
  });

  it('leaves the migration ledger alone', async () => {
    // Truncating it would make the next applyMigrations re-run everything
    // against a schema that already has it — a failure that would surface in
    // whichever suite happened to start next.
    await truncateAll(harness);

    const rows = await harness.adminDb.execute(sql`
      select count(*)::int as n from drizzle.__drizzle_migrations
    `);

    expect(Number([...rows][0]?.n)).toBeGreaterThan(0);
  });
});

describe('withTestDb', () => {
  it('yields a working database and tears it down afterwards', async () => {
    const containerId = await withTestDb(async (scoped) => {
      const rows = await scoped.db.execute(sql`select current_user as role`);

      expect([...rows][0]?.role).toBe('app_rw');

      return scoped.container.getId();
    });

    expect(containerId).toBeTruthy();
  }, 240_000);
});
