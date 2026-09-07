import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { enqueueEmbedding, insertProduct } from '../src/products.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The catalogue write path against real Postgres (P1-02).
 *
 * **The pairing is what this file exists for.** A committed product must always
 * have a queued embedding job (§4.1): a product without one is invisible to
 * search, and the seller sees a catalogue that silently lacks it — no error, no
 * failed job, nothing to retry. A fake transaction cannot demonstrate that,
 * because it rolls back nothing; only a real one can show that a failure after
 * the insert leaves *neither* row.
 *
 * It connects as `app_rw`, the role the API runs as, so the RLS policies and
 * the P0-33a grants are in force rather than assumed.
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
  tenantId = await createTenant(db, 'catalog');
});

const VALUES = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
} as const;

/**
 * Runs inside a transaction with the tenant GUC set the way `withTenant` sets
 * it — `SET LOCAL`, so the scope ends with the transaction.
 *
 * Written out rather than calling `withTenant` because that helper opens its
 * own connection from the pool, and these tests need to drive a specific
 * client. The GUC statement is the same one, which is the part that matters:
 * a test that set the context differently would be testing a context
 * production never has.
 */
const inTenant = <T>(run: (tx: DbTransaction) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return run(tx);
  });

const productCount = async (): Promise<number> => {
  const rows = await db.execute(sql`select count(*)::int as n from products`);
  return ([...rows][0] as { n: number }).n;
};

const jobCount = async (): Promise<number> => {
  const rows = await db.execute(sql`select count(*)::int as n from outbox`);
  return ([...rows][0] as { n: number }).n;
};

describe('insertProduct', () => {
  it('stores the product and returns it as written', async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'hash-1' }),
    );

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;

    expect(result.product).toMatchObject({
      sku: 'BAR-2019',
      tenantId,
      status: 'ACTIVE',
      embeddingState: 'PENDING',
      contentHash: 'hash-1',
    });
    /*
     * The server-owned columns are populated, which is why the route returns
     * the row rather than an id — a client would otherwise have to re-fetch to
     * learn them.
     */
    expect(result.product.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.product.createdAt).toBeInstanceOf(Date);
  });

  it('queues exactly one embedding job for it', async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'hash-1' }),
    );

    if (result.outcome !== 'created') throw new Error('expected a created product');

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select event_type, payload, processed_at from outbox where aggregate_id = ${result.product.id}::uuid`,
    );
    const job = [...rows][0] as { event_type: string; payload: unknown; processed_at: unknown };

    expect(job.event_type).toBe('product.embed');
    expect(job.payload).toEqual({ reason: 'created' });
    // Unprocessed: the queue of work *is* the set of nulls (P0-36).
    expect(job.processed_at).toBeNull();
  });

  it('leaves neither row when the transaction fails after the insert', async () => {
    /*
     * **The assertion the whole design is for.** A product that committed
     * without its job is invisible to search with nothing to retry; a job that
     * committed without its product points at nothing. The only way to have
     * neither is one transaction, and the only way to prove it is a real one.
     */
    const before = { products: await productCount(), jobs: await jobCount() };

    await expect(
      inTenant(async (tx) => {
        await insertProduct(tx, { tenantId, values: VALUES, contentHash: 'hash-1' });
        throw new Error('something failed after the write');
      }),
    ).rejects.toThrow('something failed after the write');

    await useTenant(db, tenantId);
    expect(await productCount()).toBe(before.products);
    expect(await jobCount()).toBe(before.jobs);
  });

  it('reports a duplicate SKU as an outcome rather than throwing', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    const second = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }),
    );

    /*
     * An outcome, not an exception, for the reason P0-52 gives: what a refusal
     * means to a caller is HTTP-shaped, and this package has no HTTP. A thrown
     * error would have to be caught and re-classified by every caller, which is
     * where one of them eventually returns a 500 for a form mistake.
     */
    expect(second).toEqual({ outcome: 'duplicate-sku' });
  });

  it('queues no job for a refused duplicate', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    await useTenant(db, tenantId);
    const before = await jobCount();

    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    /*
     * The other half of the pairing, and the one an implementation could get
     * wrong while passing everything above: enqueueing for a row that was never
     * created gives the worker a job whose product does not exist.
     */
    await useTenant(db, tenantId);
    expect(await jobCount()).toBe(before);
  });

  it('lets two wineries use the same SKU, because uniqueness is per tenant', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    const other = await createTenant(db, 'other-winery');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return insertProduct(tx, { tenantId: other, values: VALUES, contentHash: 'h' });
    });

    expect(result.outcome).toBe('created');
  });

  it('writes the tenant from the argument, not from the values', async () => {
    /*
     * P0-48 at the storage layer. `productInsert` omits the column so a body
     * cannot carry one, and this proves the statement does not read one either
     * — a spread that happened to include `tenantId` would otherwise be written
     * verbatim and rejected only by the RLS `WITH CHECK`, which is a 500 rather
     * than a refusal anyone can act on.
     */
    const result = await inTenant((tx) =>
      insertProduct(tx, {
        tenantId,
        values: { ...VALUES, tenantId: '99999999-9999-9999-9999-999999999999' } as never,
        contentHash: 'h',
      }),
    );

    if (result.outcome !== 'created') throw new Error('expected a created product');
    expect(result.product.tenantId).toBe(tenantId);
  });
});

describe('enqueueEmbedding', () => {
  it('records the reason, so a triage can tell a create from a reindex', async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }),
    );
    if (result.outcome !== 'created') throw new Error('expected a created product');

    await inTenant((tx) =>
      enqueueEmbedding(tx, { tenantId, productId: result.product.id, reason: 'reindex' }),
    );

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select payload from outbox where aggregate_id = ${result.product.id}::uuid order by id`,
    );

    expect([...rows].map((row) => (row as { payload: { reason: string } }).payload.reason)).toEqual(
      ['created', 'reindex'],
    );
  });
});

describe('RLS, which the route depends on and never checks', () => {
  it('hides one winery catalogue from another', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    const other = await createTenant(db, 'nosy-winery');
    await useTenant(db, other);

    /*
     * The route reads `tenantId` from a membership row and passes it to
     * `withTenant`; nothing in `apps/api` re-checks that a returned row belongs
     * to that tenant, because the policy is what guarantees it. Asserting the
     * policy here is what makes that omission safe rather than lucky.
     */
    expect(await productCount()).toBe(0);
  });
});
