import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { sql } from 'drizzle-orm';

import {
  BucketsExceeded,
  consumeBuckets,
  createRateLimiter,
  pruneClosedWindows,
} from '@catalogorosso/db';
import { createDbClient, type Database, type DbClient } from '@catalogorosso/db/test-support';

import { describeRateLimiter, type RateLimiter } from '../src/rate-limit-suite.js';
import { startTestDatabase, type TestDatabase } from '../src/db-harness.js';

/**
 * The Postgres limiter against real Postgres (P2-02, P2-03) — which is what
 * closes A1.
 *
 * **The concurrency case cannot be written anywhere else, and it is the reason
 * this file exists.** Fifty simultaneous calls against a limit of ten: a
 * read-then-write implementation lets far more than ten through, because every
 * caller reads the same count before any of them writes. Only real connections
 * racing against a real database can tell a correct
 * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` from a broken one.
 *
 * It runs the same conformance suite `packages/security` runs against the
 * in-memory implementation. Passing both is what makes §5.7's claim — that
 * moving off Postgres is a small change — testable rather than asserted.
 */

let harness: TestDatabase | undefined;
let client: DbClient | undefined;
let db: Database;

beforeAll(async () => {
  harness = await startTestDatabase();

  /*
   * **Its own pooled client, deliberately not `harness.db`.** The harness
   * connects with `max: 1` throughout, and for good reason — the tenant GUC is
   * session state, so every statement in a scoped test must land on the same
   * connection. But a single connection would serialise the fifty parallel
   * checks below into a queue, and the concurrency assertion would pass against
   * a read-then-write implementation that production would break on. The test
   * that cannot fail is the one worth catching here.
   */
  client = createDbClient(harness.roleUrl('app_rw'), { max: 12 });
  db = client.db;
}, 240_000);

afterAll(async () => {
  await client?.close();
  await harness?.close();
}, 60_000);

/**
 * Adapts the statement to the `RateLimiter` interface.
 *
 * The transaction is opened here rather than inside `consumeBuckets`, because
 * the rollback *is* the all-or-nothing mechanism: `BucketsExceeded` unwinds
 * every increment the call had made, so a rejected request consumes nothing
 * from the dimensions that would have allowed it.
 */
const postgresLimiter = (): RateLimiter => ({
  check: (checks) =>
    db
      .transaction((tx) => consumeBuckets(tx, checks))
      .catch((error: unknown) => {
        if (error instanceof BucketsExceeded) return error.result;
        throw error;
      }),
});

describeRateLimiter('postgres', () => ({
  limiter: postgresLimiter(),

  /*
   * A real wait, because the window is computed in SQL from `now()`. That is
   * deliberate — clock skew across Lambda containers would otherwise put two
   * requests in different windows and leak the limit — and the price is that no
   * JavaScript clock stub can move it. One second is the shortest window the
   * suite uses.
   */
  advancePast: (windowSec) =>
    new Promise<void>((resolve) => setTimeout(resolve, windowSec * 1000 + 250)),

  freshKey: () => `test:${randomUUID()}`,
}));

describe('the statement itself', () => {
  it('computes the window in SQL, never from the caller', async () => {
    const key = `test:${randomUUID()}`;

    await db.transaction((tx) => consumeBuckets(tx, [{ key, limit: 5, windowSec: 60 }]));

    /*
     * Epoch seconds out of SQL, for the same reason the implementation reads
     * them that way — and this assertion is where that lesson was learned
     * twice. `db.execute` with a raw statement bypasses Drizzle's column
     * mapping, so a `timestamptz` does not arrive as a `Date`, and the first
     * version of this line threw `start.getTime is not a function` against a
     * real database while every unit test agreed with it.
     */
    const rows = await db.execute(
      sql`SELECT extract(epoch from window_start)::double precision AS epoch
          FROM rate_limit_buckets WHERE bucket_key = ${key}`,
    );
    const epoch = Number(([...rows][0] as { epoch: number | string }).epoch);

    /*
     * The boundary is a multiple of the window in epoch seconds. Asserted
     * because this is the property that protects the limit from clock skew: a
     * window computed in the application would drift per container, and two
     * concurrent requests would each get a full allowance.
     */
    expect(Number.isFinite(epoch)).toBe(true);
    expect(epoch % 60).toBe(0);
  });

  it('starts a monthly window at the UTC month in SQL, and resets at the next one (P2-04)', async () => {
    const key = `test:${randomUUID()}`;

    const result = await db.transaction((tx) =>
      consumeBuckets(tx, [{ key, limit: 5, window: 'month' }]),
    );

    const rows = await db.execute(
      sql`SELECT
            extract(epoch from window_start)::double precision AS start_epoch,
            extract(epoch from date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC')::double precision AS month_epoch
          FROM rate_limit_buckets WHERE bucket_key = ${key}`,
    );
    const row = [...rows][0] as { start_epoch: number | string; month_epoch: number | string };
    const start = new Date(Number(row.start_epoch) * 1000);

    expect(Number(row.start_epoch)).toBe(Number(row.month_epoch));
    expect([start.getUTCDate(), start.getUTCHours(), start.getUTCMinutes()]).toEqual([1, 0, 0]);
    expect(result.resetAt).toEqual(
      new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() + 1, 1)),
    );
    expect(result).toMatchObject({ allowed: true, remaining: 4, limit: 5, key });
  });

  it('keeps the month in UTC whatever time zone the session is set to', async () => {
    const key = `test:${randomUUID()}`;

    /*
     * Calendar arithmetic on a `timestamptz` follows the session's zone, so a
     * naive `window_start + interval '1 month'` on a Europe/Rome session lands
     * an hour off across a DST change. Pinned here so a server configured in
     * local time cannot move the plan cap's boundary.
     */
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`SET LOCAL TIME ZONE 'Europe/Rome'`);
      return consumeBuckets(tx, [{ key, limit: 5, window: 'month' }]);
    });

    expect([
      result.resetAt.getUTCDate(),
      result.resetAt.getUTCHours(),
      result.resetAt.getUTCMinutes(),
    ]).toEqual([1, 0, 0]);
  });

  it('rolls back every increment when one dimension refuses', async () => {
    const [tight, loose] = [`test:${randomUUID()}`, `test:${randomUUID()}`];

    await db.transaction((tx) => consumeBuckets(tx, [{ key: tight, limit: 1, windowSec: 60 }]));

    await expect(
      db.transaction((tx) =>
        consumeBuckets(tx, [
          { key: tight, limit: 1, windowSec: 60 },
          { key: loose, limit: 10, windowSec: 60 },
        ]),
      ),
    ).rejects.toBeInstanceOf(BucketsExceeded);

    /*
     * The row for `loose` must not exist at all. This is the assertion the
     * in-memory suite cannot make — there, "consumed nothing" is a property of
     * the code; here it is a property of the transaction, and the difference is
     * whether the rollback actually happened.
     */
    const rows = await db.execute(
      sql`SELECT count FROM rate_limit_buckets WHERE bucket_key = ${loose}`,
    );
    expect([...rows]).toHaveLength(0);
  });

  it('refuses a call with no dimensions', async () => {
    // Always a caller bug, and cheaper to surface here than to let it read as
    // "allowed" on a security path.
    await expect(db.transaction((tx) => consumeBuckets(tx, []))).rejects.toThrow(/no dimensions/);
  });

  it('keeps separate keys in separate rows', async () => {
    const [a, b] = [`test:${randomUUID()}`, `test:${randomUUID()}`];

    await db.transaction((tx) =>
      consumeBuckets(tx, [
        { key: a, limit: 5, windowSec: 60 },
        { key: b, limit: 5, windowSec: 60 },
      ]),
    );

    const rows = await db.execute(
      sql`SELECT bucket_key, count FROM rate_limit_buckets WHERE bucket_key IN (${a}, ${b})`,
    );
    expect([...rows]).toHaveLength(2);
  });
});

describe('pruneClosedWindows', () => {
  it('deletes windows that have closed and leaves the current one', async () => {
    const old = `test:${randomUUID()}`;
    const current = `test:${randomUUID()}`;

    await db.execute(sql`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
      VALUES (${old}, now() - interval '2 hours', 7)
    `);
    await db.transaction((tx) => consumeBuckets(tx, [{ key: current, limit: 5, windowSec: 60 }]));

    const deleted = await pruneClosedWindows(db, 3600);
    expect(deleted).toBeGreaterThanOrEqual(1);

    const remaining = await db.execute(
      sql`SELECT bucket_key FROM rate_limit_buckets WHERE bucket_key IN (${old}, ${current})`,
    );
    const keys = [...remaining].map((r) => (r as { bucket_key: string }).bucket_key);

    // The table has no other reaper, and an unbounded one would eventually make
    // the limiter slower than the thing it protects.
    expect(keys).toEqual([current]);
  });
});

describe('peek (P2-10)', () => {
  it('reports what a window has consumed, and consumes nothing itself', async () => {
    const limiter = createRateLimiter(db);
    const month = { key: `test:${randomUUID()}`, limit: 5, window: 'month' as const };

    expect(await limiter.peek(month)).toBe(0);

    await limiter.check([month]);
    await limiter.check([month]);

    expect(await limiter.peek(month)).toBe(2);
    expect(await limiter.peek(month)).toBe(2);

    // Peeking twice spent nothing: the next check is the third, not the fifth.
    expect((await limiter.check([month])).remaining).toBe(2);
  });

  it('reads a fixed window from the same boundary consumption writes', async () => {
    const limiter = createRateLimiter(db);
    const minute = { key: `test:${randomUUID()}`, limit: 5, windowSec: 60 };

    await limiter.check([minute]);

    expect(await limiter.peek(minute)).toBe(1);
  });
});
