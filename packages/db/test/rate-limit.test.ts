import { describe, expect, it, vi } from 'vitest';

import {
  BucketsExceeded,
  consumeBuckets,
  createRateLimiter,
  pruneClosedWindows,
} from '../src/rate-limit.js';
import type { DbTransaction } from '../src/with-tenant.js';

/**
 * The limiter's statements, without a database (P2-02).
 *
 * Shapes and branches only. **Whether fifty concurrent calls against a limit of
 * ten let exactly ten through is the entire point of the design, and it cannot
 * be asserted here** — a fake transaction serialises by construction, so a
 * read-then-write implementation would pass this file and fail in production.
 * That case lives in `rate-limit.integration.test.ts`, against real connections
 * racing a real database.
 *
 * What is worth pinning here is the SQL that makes the integration result
 * possible, and the branches a container cannot easily produce.
 */

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    const rows = responses[call] ?? [];
    call += 1;
    return Promise.resolve(rows);
  });

  return { statements, execute, tx: { execute } as unknown as DbTransaction };
};

/** The literal SQL of a statement, with its bound values elided. */
const text = (statement: unknown): string =>
  ((statement as { queryChunks?: unknown[] }).queryChunks ?? [])
    .flatMap((chunk) =>
      typeof chunk === 'object' &&
      chunk !== null &&
      Array.isArray((chunk as { value?: unknown[] }).value)
        ? ((chunk as { value: unknown[] }).value as string[])
        : [],
    )
    .join(' ');

const window60 = (key: string, limit: number) => [{ key, limit, windowSec: 60 }];

/**
 * A row shaped the way postgres-js actually returns one.
 *
 * **Strings, deliberately.** The first version of this file returned a `Date`
 * and a `number`, because the fake and the code were written from the same
 * assumption — so they agreed with each other and not with Postgres, and
 * `row.window_start.getTime()` threw on every call against a real database
 * while every test here stayed green. CI caught it; this helper is what stops
 * it recurring.
 *
 * `db.execute` with a raw statement bypasses Drizzle's column mapping, so
 * whatever the driver decodes is what arrives — and it returns some numeric
 * types as strings.
 */
const row = (count: number, windowEpochSec: number) => ({
  count: String(count),
  window_epoch: String(windowEpochSec),
});

/** The current window boundary, in epoch seconds, for a 60s window. */
const nowWindow = () => Math.floor(Date.now() / 60_000) * 60;

describe('the statement', () => {
  it('is one insert-on-conflict, not a read then a write', async () => {
    const { tx, statements } = capturing([row(1, nowWindow())]);
    await consumeBuckets(tx, window60('k', 5));

    const sql = text(statements[0]);

    /*
     * The whole concurrency argument rests on this being one statement. A
     * SELECT followed by an UPDATE lets every concurrent caller read the same
     * count before any of them writes, and fifty callers then pass a limit of
     * ten.
     */
    expect(statements).toHaveLength(1);
    expect(sql).toContain('INSERT INTO rate_limit_buckets');
    expect(sql).toContain('ON CONFLICT (bucket_key, window_start)');
    expect(sql).toContain('DO UPDATE SET count = rate_limit_buckets.count + 1');
    expect(sql).toContain('RETURNING count, extract(epoch from window_start)');
  });

  it('computes the window in SQL, never from the caller', async () => {
    const { tx, statements } = capturing([row(1, nowWindow())]);
    await consumeBuckets(tx, window60('k', 5));

    /*
     * Lambda containers do not share a clock. A boundary computed in the
     * application would put two concurrent requests in different windows, each
     * getting a full allowance — which leaks the limit in exactly the way this
     * table exists to prevent.
     */
    const sql = text(statements[0]);
    expect(sql).toContain('extract(epoch from now())');
    expect(sql).not.toContain('$1::timestamptz');
  });
});

describe('the decision', () => {
  it('allows while the count is within the limit', async () => {
    const { tx } = capturing([row(3, nowWindow())]);

    const result = await consumeBuckets(tx, window60('k', 5));

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
    expect(result.resetAt).toEqual(new Date((nowWindow() + 60) * 1000));
  });

  it('throws once the count passes the limit, so the transaction rolls back', async () => {
    const { tx } = capturing([row(6, nowWindow())]);

    /*
     * The throw is a control-flow device, not an error condition: rolling back
     * is how the increments this call made get undone. Returning the rejection
     * normally would leave them committed — the partial consumption the
     * interface forbids.
     */
    await expect(consumeBuckets(tx, window60('k', 5))).rejects.toBeInstanceOf(BucketsExceeded);
  });

  it('carries the result on the exception, so the caller needs no second query', async () => {
    const { tx } = capturing([row(6, nowWindow())]);

    const error = await consumeBuckets(tx, window60('k', 5)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(BucketsExceeded);
    const { result } = error as BucketsExceeded;
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    // At least 1: zero tells a client to retry immediately, which is a hot loop
    // against the limit.
    expect(result.retryAfterSec ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('reports the tightest dimension, not the loosest', async () => {
    const { tx } = capturing([row(1, nowWindow())], [row(1, nowWindow())]);

    const result = await consumeBuckets(tx, [
      { key: 'tight', limit: 2, windowSec: 60 },
      { key: 'loose', limit: 100, windowSec: 60 },
    ]);

    // A caller shown 99 would believe it had room it does not have.
    expect(result.remaining).toBe(1);
  });

  it('checks every dimension before refusing, so the refusal names the tightest', async () => {
    const { tx, statements } = capturing([row(99, nowWindow())], [row(1, nowWindow())]);

    await consumeBuckets(tx, [
      { key: 'over', limit: 1, windowSec: 60 },
      { key: 'under', limit: 10, windowSec: 60 },
    ]).catch(() => undefined);

    // Both statements run: the rollback is what undoes them, not an early
    // return. Stopping at the first refusal would leave the loop's remaining
    // dimensions uncounted and make the result depend on argument order.
    expect(statements).toHaveLength(2);
  });

  it('refuses a call with no dimensions', async () => {
    const { tx, execute } = capturing();

    // Always a caller bug, and far cheaper to surface than to let an empty
    // array read as "allowed" on a security path.
    await expect(consumeBuckets(tx, [])).rejects.toThrow(/no dimensions/);
    expect(execute).not.toHaveBeenCalled();
  });

  it('refuses when the statement returns no row', async () => {
    // Cannot happen with `RETURNING` on an upsert, and treated as a fault
    // rather than as an allowance: the alternative is a limiter that fails open
    // when the database behaves unexpectedly.
    const { tx } = capturing([]);

    await expect(consumeBuckets(tx, window60('k', 5))).rejects.toThrow(/no row returned/);
  });
});

describe('pruneClosedWindows', () => {
  it('deletes by window age and reports how many went', async () => {
    const { tx, statements } = capturing([{}, {}, {}]);

    expect(await pruneClosedWindows(tx, 3600)).toBe(3);
    expect(text(statements[0])).toContain('DELETE FROM rate_limit_buckets');
    expect(text(statements[0])).toContain('window_start <');
  });
});

describe('createRateLimiter', () => {
  /** A database whose `transaction` just runs the callback. */
  const fakeDb = (...responses: unknown[][]) => {
    const { tx, statements } = capturing(...responses);
    const db = {
      transaction: <T>(fn: (t: DbTransaction) => Promise<T>) => fn(tx),
    } as unknown as Parameters<typeof createRateLimiter>[0];

    return { db, statements };
  };

  it('opens a transaction per check', async () => {
    const { db } = fakeDb([row(1, nowWindow())]);

    const result = await createRateLimiter(db).check(window60('k', 5));

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(4);
  });

  it('turns the rollback into a rejection result rather than an error', async () => {
    const { db } = fakeDb([row(9, nowWindow())]);

    /*
     * `BucketsExceeded` is how the transaction is rolled back — a control-flow
     * device, not a fault. The caller wants a decision, so it is caught here
     * and returned as one. Letting it escape would make every rate-limited
     * request a 500.
     */
    const result = await createRateLimiter(db).check(window60('k', 5));

    expect(result.allowed).toBe(false);
    expect(result.retryAfterSec ?? 0).toBeGreaterThanOrEqual(1);
  });

  it('lets a real fault through', async () => {
    const db = {
      transaction: () => Promise.reject(new Error('connection refused')),
    } as unknown as Parameters<typeof createRateLimiter>[0];

    /*
     * Only `BucketsExceeded` is a decision. A database that is down must not be
     * reported as "allowed" — a limiter that fails open under load is worse
     * than none, because it disappears exactly when it is needed.
     */
    await expect(createRateLimiter(db).check(window60('k', 5))).rejects.toThrow(
      /connection refused/,
    );
  });
});

describe('what the driver actually returns', () => {
  /*
   * These exist because the unit suite and the implementation were written from
   * the same wrong assumption and agreed with each other. Each case here is a
   * shape a real database produced, or could.
   */

  it('rejects on a string count, which JavaScript would otherwise compare wrong', async () => {
    // `'11' > 10` is false. Without the coercion the limiter silently stops
    // rejecting the moment the count reaches two digits.
    const { tx } = capturing([row(11, nowWindow())]);

    await expect(consumeBuckets(tx, window60('k', 10))).rejects.toBeInstanceOf(BucketsExceeded);
  });

  it('handles a numeric count and window as well as a string one', async () => {
    // Some drivers, and some column types, decode to numbers. Both must work —
    // pinning only one is how this broke in the first place.
    const { tx } = capturing([{ count: 3, window_epoch: nowWindow() }]);

    const result = await consumeBuckets(tx, window60('k', 5));
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });

  it('refuses a row it cannot read as numbers', async () => {
    /*
     * Fails loudly rather than computing `NaN`, which would make every
     * comparison false and the limiter allow everything — a limiter that fails
     * open when the database answers unexpectedly is worse than none.
     */
    const { tx } = capturing([{ count: 'not-a-number', window_epoch: 'also-not' }]);

    await expect(consumeBuckets(tx, window60('k', 5))).rejects.toThrow(/non-numeric/);
  });

  it('computes resetAt from the epoch the database reported', async () => {
    const boundary = nowWindow();
    const { tx } = capturing([row(1, boundary)]);

    // Derived from the database's own window, not from the local clock — which
    // is the property that survives clock skew across containers.
    const result = await consumeBuckets(tx, window60('k', 5));
    expect(result.resetAt).toEqual(new Date((boundary + 60) * 1000));
  });
});
