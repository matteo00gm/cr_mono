import { describe, expect, it, vi } from 'vitest';

import { countQueuedEmbeddings, reindexProduct } from '../src/products.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The reindex statements, without a database (P1-39).
 *
 * Shapes and branches only, on the same terms as the other write tests here.
 * **What a fake cannot show is the part that makes these correct**: that a
 * transaction opened for the wrong tenant matches no product, that the state
 * write and the outbox row commit together, and that the bulk `CASE` produces
 * the states it claims. Those are a policy, a transaction and real SQL, and
 * they live in `products-reindex.integration.test.ts`.
 *
 * What belongs here is which columns each statement touches and which branch it
 * takes — the kind of mistake that is invisible in review.
 */

const PRODUCT = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';

const ROW = {
  id: PRODUCT,
  tenantId: TENANT,
  name: 'Barolo Bussia',
  status: 'ACTIVE' as const,
  embeddingState: 'INDEXED' as const,
  embeddingError: 'the provider timed out',
  embeddingAttempts: 2,
};

interface Recorded {
  locked: boolean;
  readonly updated: Record<string, unknown>[];
  readonly inserted: Record<string, unknown>[];
}

const fakeTx = (product?: Record<string, unknown>) => {
  const recorded: Recorded = { locked: false, updated: [], inserted: [] };

  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        const chain = {
          for: () => {
            recorded.locked = true;
            return chain;
          },
          limit: () => Promise.resolve(product === undefined ? [] : [product]),
        };

        return chain;
      },
    }),
  }));

  const update = vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        recorded.updated.push(values);
        return Promise.resolve(undefined);
      },
    }),
  }));

  const insert = vi.fn(() => ({
    values: (values: Record<string, unknown>) => {
      recorded.inserted.push(values);
      return Promise.resolve(undefined);
    },
  }));

  return { recorded, tx: { select, update, insert } as unknown as DbTransaction };
};

/** The `queued` edge as the state machine defines it, for a row that is INDEXED. */
const toStale = (current: { state: string; error: string | null; attempts: number }) => ({
  state: 'STALE' as const,
  error: null,
  attempts: current.attempts,
});

describe('reindexProduct', () => {
  const reindex = (fake: ReturnType<typeof fakeTx>) =>
    reindexProduct(fake.tx, {
      productId: PRODUCT,
      nextStatus: toStale,
      reason: 'manual-reindex',
    });

  it('locks the row whose state it is about to overwrite', async () => {
    /*
     * The state read here decides the state written below. A concurrent edit
     * landing between the two would have this overwrite a transition it never
     * saw — an `INDEXED` result replaced by a `STALE` computed from a value
     * that is no longer there.
     */
    const fake = fakeTx(ROW);

    await reindex(fake);

    expect(fake.recorded.locked).toBe(true);
  });

  it('reports not-found for a product this transaction cannot see', async () => {
    // Deleted, or belonging to another winery — which the policy makes the same
    // thing, and which the route answers as 404 rather than 403 (§3.5).
    expect(await reindex(fakeTx())).toEqual({ outcome: 'not-found' });
  });

  it('refuses an archived wine, and queues nothing for it', async () => {
    /*
     * The worker discards a job for an archived wine by design, so enqueueing
     * one would be work nobody asked for and a state change the seller would
     * see and not understand.
     */
    const fake = fakeTx({ ...ROW, status: 'ARCHIVED' });

    expect(await reindex(fake)).toEqual({
      outcome: 'archived',
      product: { ...ROW, status: 'ARCHIVED' },
    });
    expect(fake.recorded.inserted).toHaveLength(0);
    expect(fake.recorded.updated).toHaveLength(0);
  });

  it('hands the current status to the caller rather than deciding one', async () => {
    /*
     * **The transition belongs to `packages/core`** (P1-38). This asserts the
     * three columns arrive intact: a `nextStatus` given a default-shaped status
     * instead of the real one would compute the right answer for the wrong row,
     * and every state in the catalogue would look plausible.
     */
    const seen: unknown[] = [];
    const fake = fakeTx(ROW);

    await reindexProduct(fake.tx, {
      productId: PRODUCT,
      nextStatus: (current) => {
        seen.push(current);
        return toStale(current);
      },
      reason: 'manual-reindex',
    });

    expect(seen).toEqual([{ state: 'INDEXED', error: 'the provider timed out', attempts: 2 }]);
  });

  it('writes the three status columns and nothing else', async () => {
    /*
     * **Nothing else, and that is load-bearing.** Migration 0038 gave
     * `products` a trigger that ignores exactly these three columns, so a
     * reindex does not move `updated_at`. A fourth column in this `set` is an
     * edit as far as the trigger is concerned, and a bulk reindex would send
     * every wine to the top of "recently edited" — a sort the seller reads as a
     * record of their own work.
     */
    const fake = fakeTx(ROW);

    await reindex(fake);

    expect(fake.recorded.updated).toEqual([
      { embeddingState: 'STALE', embeddingError: null, embeddingAttempts: 2 },
    ]);
  });

  it('queues the job with the tenant from the row, never from the argument', async () => {
    // P0-48 one layer down: this function is not given a tenant id at all, so
    // there is nothing for a caller to get wrong.
    const fake = fakeTx(ROW);

    await reindex(fake);

    expect(fake.recorded.inserted).toEqual([
      {
        tenantId: TENANT,
        aggregateId: PRODUCT,
        eventType: 'product.embed',
        payload: { reason: 'manual-reindex' },
      },
    ]);
  });

  it('returns the row as it now stands, not as it was read', async () => {
    /*
     * The route hands this straight to the client, and P1-40's grid renders
     * from it. Returning the pre-transition row would show a seller the state
     * their click was meant to change.
     */
    const result = await reindex(fakeTx(ROW));

    expect(result).toEqual({
      outcome: 'queued',
      product: { ...ROW, embeddingState: 'STALE', embeddingError: null, embeddingAttempts: 2 },
    });
  });
});

describe('countQueuedEmbeddings', () => {
  const countingTx = (rows: { queued: number }[]) =>
    ({
      select: () => ({ from: () => ({ where: () => Promise.resolve(rows) }) }),
    }) as unknown as DbTransaction;

  it('reports the count it was given', async () => {
    expect(await countQueuedEmbeddings(countingTx([{ queued: 412 }]))).toBe(412);
  });

  it('reports zero rather than undefined when the count comes back empty', async () => {
    /*
     * `count(*)` always returns a row, so this is unreachable through Postgres
     * — and it is the difference between `0` and `undefined` reaching
     * `reindexCatalogue`'s `> 0`, where `undefined > 0` is false and would
     * quietly allow a second run. Cheap insurance against a driver or a
     * refactor that changes the shape.
     */
    expect(await countQueuedEmbeddings(countingTx([]))).toBe(0);
  });
});
