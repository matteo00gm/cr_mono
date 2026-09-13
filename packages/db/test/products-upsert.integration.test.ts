import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import type { ProductInsert } from '../src/contracts.js';
import type { EmbeddingStatusWrite } from '../src/embedding-status.js';
import { upsertProducts, type UpsertRow } from '../src/products-upsert.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `upsertProducts` against a real database (P1-24).
 *
 * The row's tests — new rows insert, existing ones update, unchanged rows
 * enqueue nothing, outcomes classify correctly — plus the properties an import
 * must never lose: RLS scoping by SKU, archived wines staying archived, a field
 * the file did not carry left alone, and nothing half-written when the
 * transaction fails.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 2 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'import');
});

const VALUES: ProductInsert = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
};

/** The model reads name and notes; price and stock are invisible to it, as in the real rule. */
const hashOf = (values: ProductInsert): string =>
  JSON.stringify([values.name, values.tastingNotes ?? null]);

/** P1-38's `edited` edge, restated for the test the way the port supplies it. */
const edited = (current: EmbeddingStatusWrite): EmbeddingStatusWrite => ({
  state: current.state === 'INDEXED' || current.state === 'STALE' ? 'STALE' : 'PENDING',
  error: null,
  attempts: current.attempts,
});

const inTenant = <T>(run: (tx: DbTransaction) => Promise<T>, tenant = tenantId): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
    return run(tx);
  });

const importRows = (rows: readonly Partial<ProductInsert>[], tenant = tenantId) =>
  inTenant(
    (tx) =>
      upsertProducts(tx, {
        tenantId: tenant,
        rows: rows.map((values, index): UpsertRow => ({ index, values: { ...VALUES, ...values } })),
        hashOf,
        edited,
        reason: 'import',
      }),
    tenant,
  );

const scalar = async (query: ReturnType<typeof sql>): Promise<unknown> => {
  await useTenant(db, tenantId);
  const rows = await db.execute(query);
  return Object.values([...rows][0] ?? {})[0];
};

const jobCount = () => scalar(sql`select count(*)::int from outbox`);
const productCount = () => scalar(sql`select count(*)::int from products`);

describe('upsertProducts', () => {
  it('inserts new wines and queues one embedding job for each', async () => {
    const outcomes = await importRows([{ sku: 'A' }, { sku: 'B', name: 'Etna' }]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual(['created', 'created']);
    expect(await productCount()).toBe(2);
    expect(await jobCount()).toBe(2);
    expect(
      await scalar(sql`select count(*)::int from products where embedding_state = 'PENDING'`),
    ).toBe(2);
  });

  it('updates an existing wine by SKU, and re-queues it when the text changed', async () => {
    const [created] = await importRows([{}]);
    await useTenant(db, tenantId);
    await db.execute(sql`update products set embedding_state = 'INDEXED'`);

    const [outcome] = await importRows([{ tastingNotes: 'Catrame e rosa.' }]);

    expect(outcome).toMatchObject({ outcome: 'updated', reindexed: true, archived: false });
    expect(outcome && 'productId' in outcome && outcome.productId).toBe(
      created && 'productId' in created && created.productId,
    );
    expect(await productCount()).toBe(1);
    expect(await jobCount()).toBe(2);
    expect(await scalar(sql`select embedding_state::text from products`)).toBe('STALE');
    expect(await scalar(sql`select tasting_notes from products`)).toBe('Catrame e rosa.');
  });

  it('updates a price without queuing anything, because the model does not read it', async () => {
    await importRows([{}]);
    const jobsBefore = await jobCount();

    const [outcome] = await importRows([{ priceCents: 5200 }]);

    expect(outcome).toMatchObject({ outcome: 'updated', reindexed: false });
    expect(await jobCount()).toBe(jobsBefore);
    expect(await scalar(sql`select price_cents from products`)).toBe(5200);
  });

  it('writes and queues nothing for a row that changes nothing', async () => {
    await importRows([{ tastingNotes: 'Rosa.' }]);
    const jobsBefore = await jobCount();
    const stampBefore = await scalar(sql`select updated_at::text from products`);

    const [outcome] = await importRows([{ tastingNotes: 'Rosa.' }]);

    expect(outcome).toMatchObject({ outcome: 'unchanged', reindexed: false });
    expect(await jobCount()).toBe(jobsBefore);
    expect(await scalar(sql`select updated_at::text from products`)).toBe(stampBefore);
  });

  it('leaves a field the import did not carry as it was', async () => {
    await importRows([{ tastingNotes: 'Rosa.', producer: 'Poderi Colla' }]);

    await importRows([{ priceCents: 3900 }]);

    expect(await scalar(sql`select tasting_notes from products`)).toBe('Rosa.');
    expect(await scalar(sql`select producer from products`)).toBe('Poderi Colla');
  });

  it('refuses rows that share a SKU and writes neither', async () => {
    const outcomes = await importRows([{ name: 'Primo' }, { sku: 'ETN' }, { name: 'Secondo' }]);

    expect(outcomes.map((outcome) => outcome.outcome)).toEqual([
      'duplicate-sku',
      'created',
      'duplicate-sku',
    ]);
    expect(await productCount()).toBe(1);
    expect(await scalar(sql`select sku from products`)).toBe('ETN');
  });

  it('updates an archived wine’s values and leaves it archived', async () => {
    await importRows([{}]);
    await useTenant(db, tenantId);
    await db.execute(sql`update products set status = 'ARCHIVED'`);

    const [outcome] = await importRows([{ priceCents: 4100 }]);

    expect(outcome).toMatchObject({ outcome: 'updated', archived: true });
    expect(await scalar(sql`select status::text from products`)).toBe('ARCHIVED');
    expect(await scalar(sql`select price_cents from products`)).toBe(4100);
  });

  it('creates a wine whose SKU belongs to another winery, and never touches theirs', async () => {
    const otherTenant = await createTenant(db, 'import-other');
    await importRows([{ name: 'Loro' }], otherTenant);

    const [outcome] = await importRows([{ name: 'Nostro' }]);

    expect(outcome?.outcome).toBe('created');
    await useTenant(db, otherTenant);
    const theirs = await db.execute(sql`select name from products`);
    expect(([...theirs][0] as { name: string }).name).toBe('Loro');
  });

  it('leaves no wine and no job behind when the transaction fails afterwards', async () => {
    await expect(
      inTenant(async (tx) => {
        await upsertProducts(tx, {
          tenantId,
          rows: [{ index: 0, values: VALUES }],
          hashOf,
          edited,
          reason: 'import',
        });
        throw new Error('the batch failed after the upsert');
      }),
    ).rejects.toThrow('the batch failed after the upsert');

    expect(await productCount()).toBe(0);
    expect(await jobCount()).toBe(0);
  });

  it('returns nothing for an empty import without touching the database', async () => {
    expect(await importRows([])).toEqual([]);
  });
});
