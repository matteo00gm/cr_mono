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

interface Fake {
  readonly tx: DbTransaction;
  readonly inserted: { table: string; values: unknown }[];
  /** What was passed to `onConflictDoNothing`, if anything. */
  readonly conflictConfig: { value: unknown };
}

/**
 * A fake insert builder that models `onConflictDoNothing`.
 *
 * `conflicted: true` returns **no rows**, which is exactly what Postgres does
 * when the target conflicts — the whole point of the design being that nothing
 * is thrown.
 */
const fakeTx = (options: { conflicted?: boolean } = {}): Fake => {
  const inserted: { table: string; values: unknown }[] = [];
  const conflictConfig: { value: unknown } = { value: undefined };

  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      const table = 'eventType' in values ? 'outbox' : 'products';
      inserted.push({ table, values });

      const rows = options.conflicted === true ? [] : [ROW];

      return {
        onConflictDoNothing: (config: unknown) => {
          conflictConfig.value = config;
          return { returning: () => Promise.resolve(rows) };
        },
        then: (resolve: (v: unknown) => unknown) => resolve(undefined),
      };
    },
  }));

  return { inserted, conflictConfig, tx: { insert } as unknown as DbTransaction };
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

  it('reports a duplicate SKU as an empty result, never as an exception', async () => {
    /*
     * **The correction CI forced.** The first version caught the constraint
     * violation and returned an outcome — and the outcome never arrived,
     * because postgres-js marks the transaction failed on any statement error
     * and rejects the outer promise with the original error whatever the
     * callback did with it. `ON CONFLICT ... DO NOTHING` makes the conflict a
     * result instead, so there is nothing to catch and nothing to poison.
     */
    const { tx } = fakeTx({ conflicted: true });

    expect(await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' })).toEqual({
      outcome: 'duplicate-sku',
    });
  });

  it('names the conflict target, so another constraint still raises', async () => {
    /*
     * A bare `DO NOTHING` would swallow the next unique index somebody adds and
     * report a silent success — a product that was never stored, answered 201.
     */
    const { tx, conflictConfig } = fakeTx();

    await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' });

    const config = conflictConfig.value as { target?: unknown } | undefined;
    expect(config?.target).toBeDefined();
  });

  it('queues nothing for a refused duplicate', async () => {
    /*
     * The half an implementation could get wrong while passing everything
     * above: enqueueing for a row that was never created hands the worker a job
     * whose product does not exist.
     */
    const { tx, inserted } = fakeTx({ conflicted: true });

    await insertProduct(tx, { tenantId: 't', values: VALUES, contentHash: 'h' });

    expect(inserted.filter((write) => write.table === 'outbox')).toEqual([]);
  });
});
