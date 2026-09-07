import { describe, expect, it, vi } from 'vitest';

import { insertProduct, updateProduct, type ProductRow } from '../src/products.js';
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

/**
 * The patch statement's branches, without a database (P1-03).
 *
 * The hash comparison and the conditional enqueue are the shapes worth pinning
 * here; that they hold under a real transaction, with the row locked, is
 * `products.write.integration.test.ts`.
 */
const fakeUpdateTx = (row: Record<string, unknown> | undefined) => {
  const inserted: { table: string; values: unknown }[] = [];
  const updates: Record<string, unknown>[] = [];

  const tx = {
    select: () => ({
      from: () => ({
        where: () => ({
          for: (mode: string) => {
            updates.push({ lock: mode });
            return { limit: () => Promise.resolve(row === undefined ? [] : [row]) };
          },
        }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => ({
            returning: () => Promise.resolve([{ ...row, ...values }]),
          }),
        };
      },
    }),
    insert: () => ({
      values: (values: Record<string, unknown>) => {
        inserted.push({ table: 'outbox', values });
        return { then: (resolve: (v: unknown) => unknown) => resolve(undefined) };
      },
    }),
  } as unknown as DbTransaction;

  return { tx, inserted, updates };
};

const STORED = {
  id: 'p1',
  tenantId: 't1',
  name: 'Barolo',
  tastingNotes: null,
  priceCents: 4500,
  contentHash: 'stored-hash',
  embeddingState: 'INDEXED',
};

describe('updateProduct', () => {
  it('locks the row it read, so two patches cannot merge onto the same base', async () => {
    /*
     * Without `FOR UPDATE` two concurrent patches both read this row, both
     * merge onto it, and the second overwrites fields the first had just set —
     * with a hash computed from a row that never existed.
     */
    const { tx, updates } = fakeUpdateTx(STORED);

    await updateProduct(tx, { productId: 'p1', values: {}, hashOf: () => 'stored-hash' });

    expect(updates[0]).toEqual({ lock: 'update' });
  });

  it('reports not-found for a row the caller cannot see', async () => {
    const { tx } = fakeUpdateTx(undefined);

    expect(await updateProduct(tx, { productId: 'gone', values: {}, hashOf: () => 'x' })).toEqual({
      outcome: 'not-found',
    });
  });

  it('enqueues nothing and leaves the state alone when the hash is unchanged', async () => {
    const { tx, inserted, updates } = fakeUpdateTx(STORED);

    const result = await updateProduct(tx, {
      productId: 'p1',
      values: { priceCents: 9900 },
      hashOf: () => 'stored-hash',
    });

    expect(result).toMatchObject({ outcome: 'updated', reindexed: false });
    expect(inserted).toEqual([]);
    expect(updates[1]).not.toHaveProperty('embeddingState');
  });

  it('enqueues once and marks STALE when the hash moved', async () => {
    const { tx, inserted, updates } = fakeUpdateTx(STORED);

    const result = await updateProduct(tx, {
      productId: 'p1',
      values: { tastingNotes: 'New.' },
      hashOf: () => 'different-hash',
    });

    expect(result).toMatchObject({ outcome: 'updated', reindexed: true });
    expect(updates[1]).toMatchObject({ contentHash: 'different-hash', embeddingState: 'STALE' });
    expect(inserted).toHaveLength(1);
    expect(inserted[0]?.values).toMatchObject({ payload: { reason: 'updated' } });
  });

  it('hashes the merged row, not the patch', async () => {
    /*
     * A patch is partial, so hashing it alone would compare a fragment against
     * a whole row — every patch would look like a change and re-embed the
     * catalogue on every save.
     */
    const { tx } = fakeUpdateTx(STORED);
    let seen: Partial<ProductRow> | undefined;

    await updateProduct(tx, {
      productId: 'p1',
      values: { tastingNotes: 'New.' },
      hashOf: (merged) => {
        seen = merged;
        return 'stored-hash';
      },
    });

    expect(seen).toMatchObject({ name: 'Barolo', tastingNotes: 'New.', priceCents: 4500 });
  });

  it('does not let an absent field blank a stored one', async () => {
    /*
     * `productUpdate` is `.partial()`, so an unsent field arrives as
     * `undefined`. Spreading that over the row would clear every column the
     * patch did not mention — and the hash would move first, so the symptom
     * would be a re-embedding bill before it was a data-loss report.
     */
    const { tx } = fakeUpdateTx(STORED);
    let seen: Partial<ProductRow> | undefined;

    await updateProduct(tx, {
      productId: 'p1',
      values: { priceCents: 1, name: undefined },
      hashOf: (merged) => {
        seen = merged;
        return 'stored-hash';
      },
    });

    expect(seen?.name).toBe('Barolo');
  });
});
