import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The Postgres token-bucket limiter (P2-02), which is what closes A1.
 *
 * Better Auth's default store is a module-level `Map`, so in Lambda it counts
 * **per container**: N warm containers give an attacker N times each configured
 * limit, and a container recycle resets the counter to zero. A limit that
 * resets when an attacker waits is not a limit.
 *
 * **Fixed-window counters, not sliding.** Simpler, one row per key per window,
 * and adequate here: the worst case is a caller getting up to twice the limit
 * across a window boundary, which matters for a burst control and not for the
 * thing this protects — credential stuffing measured in hours.
 *
 * This lives in `packages/db` rather than in `packages/security` where P2-02's
 * Files line puts it, and the deviation is the repository's own established
 * pattern: statements live here so no domain module imports a driver (the P0-09
 * boundary rule), exactly as the audit insert, the membership read and the
 * invitation writes do. The *interface* stays in `packages/security` beside the
 * capability table, which is where the security vocabulary belongs.
 */

export type Connection = Database | DbTransaction;

export interface BucketCheck {
  readonly key: string;
  readonly limit: number;
  readonly windowSec: number;
}

export interface BucketResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly retryAfterSec?: number | undefined;
}

/**
 * Checks and consumes across every dimension, all-or-nothing.
 *
 * **Two phases, and the transaction is what makes the rule hold.** The first
 * pass increments every bucket and reads the resulting counts back; if any came
 * out over its limit, the transaction is rolled back by throwing, so nothing is
 * consumed. A caller already blocked on one dimension therefore costs the
 * others nothing — otherwise an attacker held off by their IP limit could still
 * drain the tenant's budget for free with every rejected request.
 *
 * The caller supplies the transaction, so a route that already holds one does
 * not open a second — and so this composes with `withTenant` on paths that have
 * a tenant, without requiring one on the paths that do not.
 */
export const consumeBuckets = async (
  tx: DbTransaction,
  checks: readonly BucketCheck[],
): Promise<BucketResult> => {
  if (checks.length === 0) {
    throw new Error('consumeBuckets: called with no dimensions, which is always a caller bug');
  }

  let tightest: BucketResult | undefined;
  let rejected: BucketResult | undefined;

  for (const check of checks) {
    /*
     * **The window start is computed in SQL from `now()`**, never passed in.
     * Lambda containers do not share a clock, and a window boundary computed in
     * the application would put two concurrent requests in different windows —
     * each getting a full allowance, which leaks the limit in exactly the way
     * this table exists to prevent.
     *
     * One statement per key: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
     * is a single round trip with no read-then-write race between checking a
     * count and incrementing it.
     */
    const rows = await tx.execute(sql`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
      VALUES (
        ${check.key},
        to_timestamp(floor(extract(epoch from now()) / ${check.windowSec}) * ${check.windowSec}),
        1
      )
      ON CONFLICT (bucket_key, window_start)
        DO UPDATE SET count = rate_limit_buckets.count + 1
      RETURNING count, extract(epoch from window_start)::double precision AS window_epoch
    `);

    const row = [...rows][0] as
      { count: number | string; window_epoch: number | string } | undefined;
    if (row === undefined) {
      throw new Error(`consumeBuckets: no row returned for ${check.key}`);
    }

    /*
     * **Epoch seconds out of SQL, not a timestamp**, and CI is what taught this.
     * `db.execute` with a raw statement bypasses Drizzle's column mapping, so
     * the value arrives however postgres-js decided to decode it — which was
     * not a `Date`, and `row.window_start.getTime()` threw on every call
     * against a real database while the unit tests stayed green.
     *
     * They stayed green because the fake returned a `Date`: I wrote the double
     * and the code from the same assumption, so they agreed with each other and
     * not with Postgres. A number crossing the boundary has one representation
     * and cannot do that.
     *
     * `count` is coerced for the same reason — postgres-js returns some numeric
     * types as strings, and `'11' > 10` is false in JavaScript, which would
     * silently stop rejecting.
     */
    const windowEpoch = Number(row.window_epoch);
    const count = Number(row.count);

    if (!Number.isFinite(windowEpoch) || !Number.isFinite(count)) {
      throw new Error(
        `consumeBuckets: ${check.key} returned a non-numeric count or window ` +
          `(count=${String(row.count)}, window=${String(row.window_epoch)})`,
      );
    }

    const resetAt = new Date((windowEpoch + check.windowSec) * 1000);

    if (count > check.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
      rejected ??= { allowed: false, remaining: 0, resetAt, retryAfterSec };
      continue;
    }

    const remaining = check.limit - count;
    if (tightest === undefined || remaining < tightest.remaining) {
      tightest = { allowed: true, remaining, resetAt };
    }
  }

  /*
   * Rolling back is how the consumption is undone. Returning the rejection
   * normally would leave every increment committed, which is the partial
   * consumption the interface forbids — so the caller wraps this in a
   * transaction and the throw is the signal.
   */
  if (rejected !== undefined) throw new BucketsExceeded(rejected);

  // Unreachable with a non-empty `checks`, and kept because the compiler cannot
  // see that: the loop assigns `tightest` on every non-rejected iteration.
  return tightest ?? { allowed: true, remaining: 0, resetAt: new Date() };
};

/**
 * Thrown to roll the transaction back on a rejection.
 *
 * Carries the result so the caller can answer without a second query — the
 * throw is a control-flow device for the rollback, not an error condition, and
 * a caller that had to re-read to build its response would defeat the point.
 */
export class BucketsExceeded extends Error {
  public readonly result: BucketResult;

  constructor(result: BucketResult) {
    super('rate limit exceeded');
    this.name = 'BucketsExceeded';
    this.result = result;
  }
}

/**
 * Deletes windows that have closed (P2-14's sweep, in its simplest form).
 *
 * Not scheduled here — the caller decides when. Exposed now because the table
 * has no other reaper and an unbounded one would eventually make the limiter
 * slower than the thing it protects.
 */
export const pruneClosedWindows = async (db: Connection, olderThanSec = 3600): Promise<number> => {
  const rows = await db.execute(sql`
    DELETE FROM rate_limit_buckets
    WHERE window_start < now() - (${olderThanSec} * interval '1 second')
    RETURNING 1
  `);

  return [...rows].length;
};

/**
 * A `RateLimiter` that opens its own transaction per check.
 *
 * **A narrowly-named export with a written reason, in the shape of
 * `@catalogorosso/db/auth`** — because the limiter genuinely has no scope to
 * borrow. It runs *before* authentication, so there is no user for `withUser`
 * and no membership for `withTenant`; and `rate_limit_buckets` deliberately has
 * no `tenant_id` (P0-34), because the limiter also counts callers who belong to
 * no tenant — an address hammering an invalid widget key, for instance. There
 * is therefore no scoped read for a missing context to narrow, and nothing a
 * policy could add.
 *
 * The transaction is not optional decoration: `BucketsExceeded` rolls back
 * every increment the call had made, which is how a rejected request ends up
 * consuming nothing from the dimensions that would have allowed it.
 */
export const createRateLimiter = (database: Database = getDb()) => ({
  check: (checks: readonly BucketCheck[]): Promise<BucketResult> =>
    database
      .transaction((tx) => consumeBuckets(tx, checks))
      .catch((error: unknown) => {
        if (error instanceof BucketsExceeded) return error.result;
        throw error;
      }),
});
