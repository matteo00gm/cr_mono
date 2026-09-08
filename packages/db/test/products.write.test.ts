import { describe, expect, it, vi } from 'vitest';

import { archiveProduct, insertProduct, updateProduct, type ProductRow } from '../src/products.js';
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

/**
 * The patch statement's branches, without a database (P1-03).
 *
 * The hash comparison and the conditional enqueue are the shapes worth pinning
 * here; that they hold under a real transaction, with the row locked, is
 * `products.write.integration.test.ts`.
 */
const fakeUpdateTx = (
  row: Record<string, unknown> | undefined,
  onUpdate?: () => never,
  options: { readonly updateReturnsNothing?: boolean } = {},
) => {
  const inserted: { table: string; values: unknown }[] = [];
  const updates: Record<string, unknown>[] = [];
  const savepoints: number[] = [];

  const tx: Record<string, unknown> = {
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
    /*
     * A nested transaction is a `SAVEPOINT`, which is what lets the update path
     * survive a constraint violation without ending the outer transaction. The
     * fake counts them so the design is asserted rather than assumed.
     */
    transaction: (run: (inner: unknown) => Promise<unknown>) => {
      savepoints.push(savepoints.length + 1);
      return run(tx);
    },
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        if (onUpdate) onUpdate();
        return {
          where: () => ({
            returning: () =>
              Promise.resolve(options.updateReturnsNothing === true ? [] : [{ ...row, ...values }]),
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
  };

  return { tx: tx as unknown as DbTransaction, inserted, updates, savepoints };
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
  it('runs the update inside a savepoint, which is the only way the catch works', async () => {
    /*
     * **The correction the create path forced.** postgres-js marks a
     * transaction failed on any statement error and rejects the *outer*
     * promise with it, whatever a `catch` inside returned — so classifying a
     * constraint violation is only meaningful if the statement ran somewhere
     * that can be rolled back on its own. `insertProduct` sidesteps this with
     * `ON CONFLICT DO NOTHING`; `UPDATE` has no equivalent that could be told
     * apart from "matched nothing", so it needs the savepoint.
     */
    const { tx, savepoints } = fakeUpdateTx(STORED);

    await updateProduct(tx, { productId: 'p1', values: {}, hashOf: () => 'stored-hash' });

    expect(savepoints).toHaveLength(1);
  });

  it('reports a duplicate SKU rather than letting the violation out', async () => {
    const { tx } = fakeUpdateTx(STORED, () => {
      throw Object.assign(new Error('duplicate key value violates unique constraint'), {
        code: '23505',
      });
    });

    expect(
      await updateProduct(tx, {
        productId: 'p1',
        values: { sku: 'TAKEN' },
        hashOf: () => 'stored-hash',
      }),
    ).toEqual({ outcome: 'duplicate-sku' });
  });

  it('lets any other failure out rather than calling it a duplicate', async () => {
    const { tx } = fakeUpdateTx(STORED, () => {
      throw Object.assign(new Error('check constraint violated'), { code: '23514' });
    });

    await expect(
      updateProduct(tx, { productId: 'p1', values: {}, hashOf: () => 'stored-hash' }),
    ).rejects.toThrow(/check constraint/);
  });

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

describe('updateProduct, the case that cannot happen', () => {
  it('refuses to enqueue for a row the update did not return', async () => {
    /*
     * Unreachable: the row was locked with `FOR UPDATE` before the statement
     * ran, so it cannot have gone. Kept, and covered, because the alternative
     * to throwing is enqueueing an embedding job for `undefined.id` — a job
     * pointing at nothing, which the worker fails on forever and nobody can
     * trace back to an edit that reported success.
     */
    const { tx, inserted } = fakeUpdateTx(STORED, undefined, { updateReturnsNothing: true });

    await expect(
      updateProduct(tx, {
        productId: 'p1',
        values: { tastingNotes: 'New.' },
        hashOf: () => 'different-hash',
      }),
    ).rejects.toThrow(/returned no row/);

    expect(inserted).toEqual([]);
  });
});

/**
 * A transaction whose update and delete both report what they were asked for.
 *
 * The archive path is two statements that must both happen or neither, and the
 * "neither" half is `products.write.integration.test.ts` — a fake rolls nothing
 * back. What is worth pinning here is the branch a container reaches only by
 * scoping a whole second tenant: a row the caller cannot see.
 */
const fakeArchiveTx = (row: Record<string, unknown> | undefined, vectors = 1) => {
  const deletes: number[] = [];

  const tx = {
    update: () => ({
      set: () => ({
        where: () => ({ returning: () => Promise.resolve(row === undefined ? [] : [row]) }),
      }),
    }),
    delete: () => ({
      where: () => ({
        returning: () => {
          deletes.push(vectors);
          return Promise.resolve(Array.from({ length: vectors }, (_, i) => ({ id: String(i) })));
        },
      }),
    }),
  } as unknown as DbTransaction;

  return { tx, deletes };
};

describe('archiveProduct', () => {
  it('archives and reports how many vectors went', async () => {
    const { tx } = fakeArchiveTx({ id: 'p1', status: 'ARCHIVED' }, 3);

    expect(await archiveProduct(tx, 'p1')).toMatchObject({
      outcome: 'archived',
      vectorsRemoved: 3,
    });
  });

  it('reports zero vectors without treating it as a failure', async () => {
    /*
     * Zero is meaningful rather than suspicious: the wine had never been
     * indexed. Conflating that with a delete that failed to clean up would send
     * somebody looking for a bug that is not there.
     */
    const { tx } = fakeArchiveTx({ id: 'p1', status: 'ARCHIVED' }, 0);

    expect(await archiveProduct(tx, 'p1')).toMatchObject({ vectorsRemoved: 0 });
  });

  it('does not delete vectors for a row it could not see', async () => {
    /*
     * **The branch that matters.** The delete names only the product id, so
     * running it for a row the policy hid would let one tenant clear another
     * tenant's index — and the update returning nothing is the only thing that
     * stops it.
     */
    const { tx, deletes } = fakeArchiveTx(undefined);

    expect(await archiveProduct(tx, 'gone')).toEqual({ outcome: 'not-found' });
    expect(deletes).toEqual([]);
  });
});
