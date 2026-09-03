import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `outbox` against real Postgres (P0-36).
 *
 * The rollback test is the guarantee this table exists to provide. Everything
 * else here is shape; that one is the reason for the design.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

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

beforeEach(async () => {
  tenantId = await createTenant(db, 'outbox');
});

const countRows = async (table: 'products' | 'outbox'): Promise<number> => {
  const rows = await db.execute(
    table === 'products'
      ? sql`select count(*)::int as n from products where tenant_id = ${tenantId}::uuid`
      : sql`select count(*)::int as n from outbox where tenant_id = ${tenantId}::uuid`,
  );

  return Number([...rows][0]?.n);
};

describe('outbox', () => {
  it('rolls back with the product it was written beside', async () => {
    /*
     * The actual guarantee. A product committed without a queued embedding job
     * is invisible to search, and the seller sees a catalog that silently
     * lacks it. Writing both in one transaction is what makes that impossible:
     * either both land or neither does.
     *
     * A publish-after-commit cannot offer this — the process can die in the
     * gap, and nothing afterwards knows a job is missing.
     */
    await expect(
      db.transaction(async (tx) => {
        await tx.execute(sql`
          insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
          values (${tenantId}::uuid, 'SKU-TX', 'Barolo', 'RED', 4200, 'EUR', 'IN_STOCK')
        `);
        await tx.execute(sql`
          insert into outbox (tenant_id, aggregate_id, event_type)
          values (${tenantId}::uuid, gen_random_uuid(), 'product.upserted')
        `);

        throw new Error('rollback');
      }),
    ).rejects.toThrow('rollback');

    expect(await countRows('products')).toBe(0);
    expect(await countRows('outbox')).toBe(0);
  });

  it('commits both together when the transaction succeeds', async () => {
    await db.transaction(async (tx) => {
      await tx.execute(sql`
        insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
        values (${tenantId}::uuid, 'SKU-OK', 'Barbera', 'RED', 1800, 'EUR', 'IN_STOCK')
      `);
      await tx.execute(sql`
        insert into outbox (tenant_id, aggregate_id, event_type)
        values (${tenantId}::uuid, gen_random_uuid(), 'product.upserted')
      `);
    });

    expect(await countRows('products')).toBe(1);
    expect(await countRows('outbox')).toBe(1);
  });

  it('serves the poller only unprocessed rows, in insertion order', async () => {
    for (const type of ['first', 'second', 'third']) {
      await db.execute(sql`
        insert into outbox (tenant_id, aggregate_id, event_type)
        values (${tenantId}::uuid, gen_random_uuid(), ${type})
      `);
    }
    await db.execute(sql`
      update outbox set processed_at = now()
      where tenant_id = ${tenantId}::uuid and event_type = 'first'
    `);

    const rows = await db.execute(sql`
      select event_type from outbox
      where tenant_id = ${tenantId}::uuid and processed_at is null
      order by id
    `);

    expect([...rows].map((r) => r.event_type)).toEqual(['second', 'third']);
  });

  it('starts attempts at zero so a retry count is never null', async () => {
    const rows = await db.execute(sql`
      insert into outbox (tenant_id, aggregate_id, event_type)
      values (${tenantId}::uuid, gen_random_uuid(), 'x')
      returning attempts, processed_at
    `);
    const row = [...rows][0];

    expect(Number(row?.attempts)).toBe(0);
    expect(row?.processed_at).toBeNull();
  });

  it('goes with its tenant', async () => {
    await db.execute(sql`
      insert into outbox (tenant_id, aggregate_id, event_type)
      values (${tenantId}::uuid, gen_random_uuid(), 'x')
    `);
    await db.execute(sql`delete from tenants where id = ${tenantId}::uuid`);

    expect(await countRows('outbox')).toBe(0);
  });
});
