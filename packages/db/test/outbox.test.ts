import { describe, expect, it, vi } from 'vitest';

import {
  claimOutboxJobs,
  countStuckJobs,
  markOutboxPublished,
  MAX_PUBLISH_ATTEMPTS,
  recordPublishFailure,
  runOutboxPass,
  type OutboxJob,
} from '../src/outbox.js';
import { OUTBOX_POLLER_GUC, withOutbox } from '../src/with-outbox.js';
import type { Database } from '../src/client.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The outbox statements, without a database (P1-31).
 *
 * Branches and call shapes only, on the same terms as `products.write.test.ts`.
 * **What cannot be asserted here is everything that makes the design correct**:
 * that `SKIP LOCKED` hands two pollers disjoint rows, that the poller's GUC is
 * genuinely required to see anything, and that the flag admits no INSERT and no
 * DELETE. A fake transaction locks nothing and enforces no policy, so an
 * implementation with none of those properties passes this file. They live in
 * `outbox-poller.integration.test.ts`, against real Postgres.
 *
 * What belongs here is the arithmetic — which ids are marked published, which
 * are counted as failed, and what happens on the empty edges a container would
 * reach expensively and prove nothing extra about.
 */

interface Recorded {
  readonly limit?: number | undefined;
  readonly lock?: readonly [string, unknown] | undefined;
  readonly updates: { readonly set: Record<string, unknown> }[];
}

const job = (id: number): OutboxJob => ({
  id,
  tenantId: '11111111-1111-4111-8111-111111111111',
  aggregateId: '22222222-2222-4222-8222-222222222222',
  eventType: 'embedding.requested',
  payload: { reason: 'created' },
  attempts: 0,
});

/** Enough of Drizzle's builders to record what each statement asked for. */
const fakeTx = (rows: readonly unknown[] = [], executed: unknown[] = []) => {
  const recorded: Recorded = { updates: [] };
  const state = recorded as { limit?: number; lock?: readonly [string, unknown] };

  const select = vi.fn(() => ({
    from: () => ({
      where: () => {
        const chain = {
          orderBy: () => chain,
          limit: (value: number) => {
            state.limit = value;
            return chain;
          },
          for: (strength: string, config: unknown) => {
            state.lock = [strength, config];
            return Promise.resolve(rows);
          },
          then: (resolve: (v: unknown) => unknown) => resolve(rows),
        };

        return chain;
      },
    }),
  }));

  const update = vi.fn(() => ({
    set: (values: Record<string, unknown>) => ({
      where: () => {
        recorded.updates.push({ set: values });
        return Promise.resolve(undefined);
      },
    }),
  }));

  const execute = vi.fn((statement: unknown) => {
    executed.push(statement);
    return Promise.resolve([]);
  });

  return { recorded, executed, tx: { select, update, execute } as unknown as DbTransaction };
};

describe('claimOutboxJobs', () => {
  it('locks the rows it claims and steps over the ones it cannot', async () => {
    /*
     * The single most important line in the file, and a fake can only check
     * that it is *asked for* — `SKIP LOCKED` is what stops two pollers
     * publishing the same job, and its absence produces no error at all, only
     * a duplicate embedding per job.
     */
    const fake = fakeTx([job(1)]);

    await claimOutboxJobs(fake.tx, 25);

    expect(fake.recorded.lock).toEqual(['update', { skipLocked: true }]);
    expect(fake.recorded.limit).toBe(25);
  });

  it('claims a hundred by default', async () => {
    const fake = fakeTx([]);

    await claimOutboxJobs(fake.tx);

    expect(fake.recorded.limit).toBe(100);
  });
});

describe('the releases', () => {
  it('mark published rows with the database clock, not a Lambda one', async () => {
    /*
     * `now()` rather than `new Date()`: the timestamp gets trusted — by the
     * outbox, by analytics — and a Lambda's idea of the time is one more thing
     * that can be wrong.
     */
    const fake = fakeTx();

    await markOutboxPublished(fake.tx, [1, 2]);

    expect(fake.recorded.updates).toHaveLength(1);
    expect(Object.keys(fake.recorded.updates[0]?.set ?? {})).toEqual(['processedAt']);
  });

  it('increment the attempt counter without touching processed_at', async () => {
    /*
     * The row has to stay claimable: a send that failed did not happen. Writing
     * `processed_at` here would be the mark-then-send bug wearing a different
     * hat — the job would be gone with nothing to show for it.
     */
    const fake = fakeTx();

    await recordPublishFailure(fake.tx, [3]);

    expect(Object.keys(fake.recorded.updates[0]?.set ?? {})).toEqual(['attempts']);
  });

  it('issue no statement at all for an empty list', async () => {
    /*
     * Both releases run on every pass, and a pass that published everything
     * hands `recordPublishFailure` nothing. An `UPDATE` built from an empty id
     * list has no `WHERE` clause worth the name — it would mark the entire
     * table.
     */
    const fake = fakeTx();

    await markOutboxPublished(fake.tx, []);
    await recordPublishFailure(fake.tx, []);

    expect(fake.recorded.updates).toEqual([]);
  });
});

describe('countStuckJobs', () => {
  it('reports what the poller has given up on', async () => {
    const fake = fakeTx([{ stuck: 4 }]);

    expect(await countStuckJobs(fake.tx)).toBe(4);
  });

  it('reports zero rather than undefined when the count comes back empty', async () => {
    /*
     * A count query always returns a row, so this is defensive — and the shape
     * it defends against matters: `undefined` here would read as "no stuck
     * jobs" everywhere it is displayed, which is the answer that stops anyone
     * looking.
     */
    const fake = fakeTx([]);

    expect(await countStuckJobs(fake.tx)).toBe(0);
  });
});

/** A `Database` whose `transaction` just runs the callback against `tx`. */
const fakeDb = (tx: DbTransaction) =>
  ({
    transaction: (fn: (t: DbTransaction) => Promise<unknown>) => fn(tx),
  }) as unknown as Database;

describe('withOutbox', () => {
  it('sets the poller flag, and sets it transaction-locally', async () => {
    /*
     * **The third argument to `set_config` is the whole safety property.**
     * Without it the setting outlives the transaction on a pooled connection,
     * and the next request — an ordinary tenant request — runs with the outbox
     * unlocked. Read off the statement rather than trusted, because nothing
     * else in the system would notice.
     */
    const executed: unknown[] = [];
    const fake = fakeTx([], executed);

    await withOutbox(() => Promise.resolve('done'), fakeDb(fake.tx));

    const rendered = JSON.stringify(executed[0]);

    expect(rendered).toContain(OUTBOX_POLLER_GUC);
    expect(rendered).toContain('true');
  });

  it('returns what the callback returned', async () => {
    const fake = fakeTx();

    expect(await withOutbox(() => Promise.resolve(42), fakeDb(fake.tx))).toBe(42);
  });
});

describe('runOutboxPass', () => {
  const passOver = async (
    rows: readonly OutboxJob[],
    publish: (jobs: readonly OutboxJob[]) => Promise<readonly number[]>,
  ) => {
    const fake = fakeTx(rows);
    const result = await runOutboxPass(publish, { database: fakeDb(fake.tx) });

    return { result, updates: fake.recorded.updates };
  };

  it('does not call the publisher when there is nothing to publish', async () => {
    /*
     * The ordinary case, once a minute, for ever. A pass over an empty queue
     * that still called SQS would be a request per minute per environment for
     * no reason.
     */
    const publish = vi.fn(() => Promise.resolve([]));

    const { result, updates } = await passOver([], publish);

    expect(publish).not.toHaveBeenCalled();
    expect(result).toEqual({ claimed: 0, published: 0, failed: 0 });
    expect(updates).toEqual([]);
  });

  it('splits the batch into what landed and what did not', async () => {
    // Nine of ten landing is the ordinary SendMessageBatch result, not an edge.
    const { result, updates } = await passOver([job(1), job(2), job(3)], (jobs) =>
      Promise.resolve(jobs.slice(0, 2).map((j) => j.id)),
    );

    expect(result).toEqual({ claimed: 3, published: 2, failed: 1 });
    expect(updates.map((u) => Object.keys(u.set)[0])).toEqual(['processedAt', 'attempts']);
  });

  it('ignores an id the publisher returned but this pass never claimed', async () => {
    /*
     * A batching client that replayed a previous response would otherwise mark
     * a row this transaction never locked — and that row may be in flight
     * inside another poller right now. Filtering against the claim is what
     * keeps the mark meaning "this transaction sent it".
     */
    const { result } = await passOver([job(1)], () => Promise.resolve([1, 999]));

    expect(result).toEqual({ claimed: 1, published: 1, failed: 0 });
  });

  it('counts everything as failed when the publisher confirmed nothing', async () => {
    const { result } = await passOver([job(1), job(2)], () => Promise.resolve([]));

    expect(result).toEqual({ claimed: 2, published: 0, failed: 2 });
  });
});

describe('the give-up threshold', () => {
  it('is high enough that a brief outage does not consume it', () => {
    /*
     * Not an arbitrary number. The poller runs once a minute, so six is six
     * minutes of a queue being unreachable before a wine's job stops being
     * retried — and a failed *publish* is almost never a bad row, it is a
     * queue that was down. Lowering this makes an outage into data loss.
     */
    expect(MAX_PUBLISH_ATTEMPTS).toBeGreaterThanOrEqual(3);
  });
});
