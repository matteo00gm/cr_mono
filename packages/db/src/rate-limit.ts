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

/** A window of `windowSec` seconds, aligned to the epoch. */
export interface FixedBucketCheck {
  readonly key: string;
  readonly limit: number;
  readonly windowSec: number;
}

/** A UTC calendar month (P2-04) — see `MonthlyCheck` in `packages/security`. */
export interface MonthlyBucketCheck {
  readonly key: string;
  readonly limit: number;
  readonly window: 'month';
}

export type BucketCheck = FixedBucketCheck | MonthlyBucketCheck;

export interface BucketResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  /** The limit of the dimension this result describes. */
  readonly limit: number;
  /** That dimension's key, so a caller can tell a burst limit from the plan cap. */
  readonly key: string;
  readonly retryAfterSec?: number | undefined;
}

/**
 * Where a check's window starts, and where it ends — both in SQL.
 *
 * **The start is computed from `now()`, never passed in.** Lambda containers do
 * not share a clock, and a window boundary computed in the application would put
 * two concurrent requests in different windows — each getting a full allowance,
 * which leaks the limit in exactly the way this table exists to prevent.
 *
 * **The month is taken `AT TIME ZONE 'UTC'` in both directions.** Calendar
 * arithmetic on a `timestamptz` follows the session's time zone, so on a server
 * set to Europe/Rome `window_start + interval '1 month'` lands an hour off across
 * a DST change — and the plan cap would reset early. Converting to UTC wall
 * time, adding the month there and converting back is the version with no zone
 * in it.
 *
 * The end refers to `window_start` because it is read in `RETURNING`, from the
 * row the upsert produced: the window Postgres actually counted in, rather than
 * a second call to `now()` that might disagree with it.
 */
const bounds = (check: BucketCheck) =>
  'window' in check
    ? {
        start: sql`date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'`,
        end: sql`(date_trunc('month', window_start AT TIME ZONE 'UTC') + interval '1 month') AT TIME ZONE 'UTC'`,
      }
    : {
        start: sql`to_timestamp(floor(extract(epoch from now()) / ${check.windowSec}) * ${check.windowSec})`,
        end: sql`window_start + make_interval(secs => ${check.windowSec})`,
      };

/**
 * Checks and consumes across every dimension, all-or-nothing.
 *
 * **Two phases, and the transaction is what makes the rule hold.** The first pass
 * increments every bucket and reads the resulting counts back; if any came out
 * over its limit, the transaction is rolled back by throwing, so nothing is
 * consumed. A caller already blocked on one dimension therefore costs the others
 * nothing — otherwise an attacker held off by their IP limit could still drain
 * the tenant's budget for free with every rejected request.
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
    if (
      !('window' in check) &&
      !(
        Number.isInteger(check.windowSec) &&
        check.windowSec > 0 &&
        check.windowSec <= MAX_FIXED_WINDOW_SEC
      )
    ) {
      throw new Error(
        `consumeBuckets: ${check.key} asks for a ${String(check.windowSec)}s window. A fixed ` +
          `window is a whole number of seconds up to ${String(MAX_FIXED_WINDOW_SEC)}, because ` +
          'the sweep deletes one that long after it starts (P2-14); anything longer is a month.',
      );
    }

    const { start, end } = bounds(check);

    /*
     * One statement per key: `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`
     * is a single round trip with no read-then-write race between checking a
     * count and incrementing it.
     */
    const rows = await tx.execute(sql`
      INSERT INTO rate_limit_buckets (bucket_key, window_start, count)
      VALUES (${check.key}, ${start}, 1)
      ON CONFLICT (bucket_key, window_start)
        DO UPDATE SET count = rate_limit_buckets.count + 1
      RETURNING count, extract(epoch from ${end})::double precision AS reset_epoch
    `);

    const row = [...rows][0] as
      { count: number | string; reset_epoch: number | string } | undefined;
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
    const resetEpoch = Number(row.reset_epoch);
    const count = Number(row.count);

    if (!Number.isFinite(resetEpoch) || !Number.isFinite(count)) {
      throw new Error(
        `consumeBuckets: ${check.key} returned a non-numeric count or reset ` +
          `(count=${String(row.count)}, reset=${String(row.reset_epoch)})`,
      );
    }

    const resetAt = new Date(resetEpoch * 1000);

    if (count > check.limit) {
      const retryAfterSec = Math.max(1, Math.ceil((resetAt.getTime() - Date.now()) / 1000));
      rejected ??= {
        allowed: false,
        remaining: 0,
        resetAt,
        limit: check.limit,
        key: check.key,
        retryAfterSec,
      };
      continue;
    }

    const remaining = check.limit - count;
    if (tightest === undefined || remaining < tightest.remaining) {
      tightest = { allowed: true, remaining, resetAt, limit: check.limit, key: check.key };
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
  return tightest ?? { allowed: true, remaining: 0, resetAt: new Date(), limit: 0, key: '' };
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
 * The longest fixed window the limiter counts (P2-14).
 *
 * **What makes the sweep safe, enforced where windows are made.** The sweep
 * deletes a fixed window this long after it starts, which is right only while no
 * fixed window is longer. Longer windows are months, which the sweep knows about.
 * `consumeBuckets` refuses anything else, so a daily limit added later fails its
 * first request instead of being reset by every sweep.
 */
export const MAX_FIXED_WINDOW_SEC = 3600;

/** How many rows one sweep statement deletes (P2-14): short statements, short locks. */
export const PRUNE_BATCH = 1_000;

/**
 * Deletes a batch of windows that have closed (P2-14).
 *
 * **Two kinds of window, and the current month has to survive.**
 * - A fixed window closes at most `MAX_FIXED_WINDOW_SEC` after it starts, so one
 *   that started longer ago than that is over.
 * - A month is over only when the month is. This month's bucket is the plan cap a
 *   winery is counting against (P2-04), and a sweep that deleted it would hand
 *   every tenant a fresh month every quarter of an hour — which is what the first
 *   version of this function, deleting anything an hour old, would have done
 *   once scheduled. So its start is excluded by name; every other month started
 *   before this one, and is over.
 *
 * `LIMIT` inside a keyed subselect, so a large backlog goes in short statements
 * rather than one that holds the table. The caller loops.
 */
export const pruneClosedWindows = async (
  limit: number = PRUNE_BATCH,
  db: Connection = getDb(),
): Promise<number> => {
  const rows = await db.execute(sql`
    DELETE FROM rate_limit_buckets
    WHERE (bucket_key, window_start) IN (
      SELECT bucket_key, window_start FROM rate_limit_buckets
      WHERE window_start < now() - make_interval(secs => ${MAX_FIXED_WINDOW_SEC})
        AND window_start <> date_trunc('month', now() AT TIME ZONE 'UTC') AT TIME ZONE 'UTC'
      LIMIT ${limit}
    )
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

  /**
   * How much of a window has been consumed, **without consuming any** (P2-10).
   *
   * The config route tells a widget whether its month is nearly spent, and the
   * only honest source is the bucket that actually refuses messages: a count
   * kept anywhere else could say `ok` while chat is being refused. The window
   * is computed by the same expression consumption writes, so a peek and a
   * check always name the same row.
   *
   * A method of this limiter rather than a new function, because the limiter is
   * the named caller of `rate_limit_buckets` on a connection that sets nothing
   * (ADR 0020). A second way in would be a second caller to name.
   */
  peek: async (check: BucketCheck): Promise<number> => {
    const rows = await database.execute(sql`
      SELECT count FROM rate_limit_buckets
      WHERE bucket_key = ${check.key} AND window_start = ${bounds(check).start}
    `);

    const row = [...rows][0] as { count: number | string } | undefined;
    if (row === undefined) return 0;

    const count = Number(row.count);
    if (!Number.isFinite(count)) {
      throw new Error(`peek: ${check.key} returned a non-numeric count (${String(row.count)})`);
    }

    return count;
  },
});
