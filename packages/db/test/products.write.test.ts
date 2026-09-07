import { describe, expect, it, vi } from 'vitest';

import { insertProduct } from '../src/products.js';
import type { DbTransaction } from '../src/with-tenant.js';
import type { ProductInsert } from '../src/contracts.js';

/**
 * The catalogue write statements, without a database (P1-02).
 *
 * Branches and shapes only. **Whether the product and its outbox row really
 * commit together cannot be asserted here** — a fake transaction rolls back
 * nothing, so an implementation that wrote them on two connections would pass
 * this file and lose embedding jobs in production. That case lives in
 * `products.write.integration.test.ts`, against real Postgres.
 *
 * What belongs here is the branch a container reaches expensively: the
 * duplicate SKU, which needs a driver error with a specific SQLSTATE wrapped
 * the way Drizzle wraps one.
 */

const VALUES = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
} as ProductInsert;

const ROW = { id: '7c9e6679-7425-40de-944b-e07fc1f90ae7', sku: 'BAR-2019' };

/**
 * A driver error shaped the way one actually arrives.
 *
 * **The SQLSTATE is on `cause`, not on the error itself**, because Drizzle
 * wraps what postgres-js threw. A fake that put `code` at the top level would
 * agree with a `pgErrorCode` that read it there — and both would be wrong about
 * the same thing, which is precisely how A1's timestamp bug survived a green
 * suite.
 */
const driverError = (code: string) =>
  Object.assign(new Error('Failed query: insert into "products" ...'), { cause: { code } });

interface Fake {
  readonly tx: DbTransaction;
  readonly inserted: { table: string; values: unknown }[];
}

const fakeTx = (options: { onProductInsert?: () => never; noRow?: boolean } = {}): Fake => {
  const inserted: { table: string; values: unknown }[] = [];

  /*
   * Distinguishes the two tables by the columns the values carry, because the
   * table object itself is a Drizzle internal that a fake has no business
   * asserting on. `event_type` only exists on the outbox side.
   */
  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      const table = 'eventType' in values ? 'outbox' : 'products';
      inserted.push({ table, values });

      if (table === 'products' && options.onProductInsert) options.onProductInsert();

      return {
        returning: () => Promise.resolve(options.noRow === true ? [] : [ROW]),
        then: (resolve: (v: unknown) => unknown) => resolve(undefined),
      };
    },
  }));

  return { inserted, tx: { insert } as unknown as DbTransaction };
};

describe('insertProduct', () => {
  it('writes the tenant from the argument and never from the values', async () => {
    const { tx, inserted } = fakeTx();

    await insertProduct(tx, {
      tenantId: 'tenant-1',
      // A body could never carry this — `productInsert` omits the column — but
      // a future spread might, and P0-48 is a rule about the value that lands.
      values: { ...VALUES, tenantId: 'tenant-2' } as never,
      contentHash: 'hash-1',
    });

    expect(inserted[0]?.values).toMatchObject({ tenantId: 'tenant-1' });
  });

  it('stores the hash it was given, and does not compute one', async () => {
    /*
     * Which fields a hash covers is a domain decision — it decides what an edit
     * costs — and this package has no domain. Computing one here would put that
     * rule in a place with no test for it.
     */
    const { tx, inserted } = fakeTx();

    await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'hash-1' });

    expect(inserted[0]?.values).toMatchObject({ contentHash: 'hash-1', embeddingState: 'PENDING' });
  });

  it('queues the embedding job in the same call, not as a second step', async () => {
    const { tx, inserted } = fakeTx();

    await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' });

    expect(inserted.map((write) => write.table)).toEqual(['products', 'outbox']);
    expect(inserted[1]?.values).toMatchObject({
      aggregateId: ROW.id,
      eventType: 'product.embed',
      payload: { reason: 'created' },
    });
  });

  it('reports a duplicate SKU rather than throwing', async () => {
    const { tx } = fakeTx({
      onProductInsert: () => {
        throw driverError('23505');
      },
    });

    expect(await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' })).toEqual({
      outcome: 'duplicate-sku',
    });
  });

  it('queues nothing for a refused duplicate', async () => {
    /*
     * The half an implementation could get wrong while passing everything
     * above: enqueueing for a row that was never created hands the worker a job
     * whose product does not exist.
     */
    const { tx, inserted } = fakeTx({
      onProductInsert: () => {
        throw driverError('23505');
      },
    });

    await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' });

    expect(inserted.filter((write) => write.table === 'outbox')).toEqual([]);
  });

  it('lets any other database failure out', async () => {
    /*
     * Only `23505` is an outcome. A connection failure or a check violation is
     * ours to fix, and swallowing it as "duplicate" would tell a seller their
     * SKU was taken while the real problem was somewhere else entirely.
     */
    const { tx } = fakeTx({
      onProductInsert: () => {
        throw driverError('23514');
      },
    });

    await expect(
      insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' }),
    ).rejects.toThrow(/Failed query/);
  });

  it('refuses to queue a job for a row it cannot see', async () => {
    /*
     * Unreachable in practice: `RETURNING` on a single-row insert that did not
     * throw yields exactly one row. Kept, and covered, because the alternative
     * to throwing is enqueueing an embedding job for `undefined.id` — a job
     * pointing at nothing, which the worker would fail on forever and which
     * nobody could trace back to a create that reported success.
     */
    const { tx, inserted } = fakeTx({ noRow: true });

    await expect(
      insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' }),
    ).rejects.toThrow(/returned no row/);

    expect(inserted.filter((write) => write.table === 'outbox')).toEqual([]);
  });
});
