import { describe, expect, it } from 'vitest';

import { describeRateLimiter, tallyWindows } from '@catalogorosso/testing';

import { memoryRateLimiter, monthWindowMs, windowStartMs } from '../src/rate-limit/index.js';

/**
 * The in-memory limiter, and the arithmetic both implementations share (P2-01).
 *
 * The *conformance* suite runs against this too — see
 * `packages/testing/src/rate-limit-suite.ts`, which both this package and
 * `packages/db` invoke. What is here is the handful of properties that belong
 * to this implementation alone, plus `windowStartMs`, which the Postgres
 * version computes in SQL and this one computes in JavaScript: if the two
 * disagree the conformance suite passes against both and lies about one.
 */

describe('windowStartMs', () => {
  it('floors to the window boundary', () => {
    // 90s into a 60s window is the second window, starting at 60s.
    expect(windowStartMs(90_000, 60)).toBe(60_000);
    expect(windowStartMs(60_000, 60)).toBe(60_000);
    expect(windowStartMs(59_999, 60)).toBe(0);
  });

  it('agrees with the SQL the Postgres limiter uses', () => {
    /*
     * The Postgres statement computes
     * `floor(extract(epoch from now()) / w) * w`, in seconds. This is the same
     * arithmetic in milliseconds, and the pair is asserted here because the two
     * are written in different languages in different packages and nothing else
     * would notice them drifting apart.
     */
    const epochSec = 1_788_790_164;
    const windowSec = 60;
    const fromSql = Math.floor(epochSec / windowSec) * windowSec;

    expect(windowStartMs(epochSec * 1000, windowSec)).toBe(fromSql * 1000);
  });
});

describe('the memory limiter', () => {
  it('is per-process, which is the whole of A1', async () => {
    /*
     * Two limiters are two counters for the same key — which is exactly what
     * Better Auth's default store does across Lambda containers, and why it
     * cannot be the production backend: N containers give N times the limit.
     * Asserted rather than only described, so the reason this implementation is
     * test-only is visible in the suite.
     */
    const a = memoryRateLimiter();
    const b = memoryRateLimiter();
    const check = [{ key: 'ip:1.2.3.4', limit: 1, windowSec: 60 }];

    expect((await a.check(check)).allowed).toBe(true);
    expect((await a.check(check)).allowed).toBe(false);

    // The second "container" has its own count and lets the caller straight in.
    expect((await b.check(check)).allowed).toBe(true);
  });

  it('takes its clock as a parameter, so window rollover is testable', async () => {
    let now = 0;
    const limiter = memoryRateLimiter(() => now);
    const check = [{ key: 'k', limit: 1, windowSec: 10 }];

    expect((await limiter.check(check)).allowed).toBe(true);
    expect((await limiter.check(check)).allowed).toBe(false);

    now = 10_000;
    expect((await limiter.check(check)).allowed).toBe(true);
  });

  it('refuses nothing when given no dimensions', async () => {
    // Degenerate, and worth pinning: an empty array must not be read as "deny".
    // The Postgres implementation throws on it instead, because there a caller
    // reaching the database with nothing to check is a bug worth surfacing.
    expect((await memoryRateLimiter().check([])).allowed).toBe(true);
  });
});

describe('the monthly window (P2-04)', () => {
  const check = [{ key: 'tenant:t:month', limit: 1, window: 'month' as const }];

  it('rolls over at the start of the next UTC month, and says so', async () => {
    let now = Date.UTC(2026, 0, 31, 23, 59, 59, 999);
    const limiter = memoryRateLimiter(() => now);

    const allowed = await limiter.check(check);
    expect(allowed.resetAt).toEqual(new Date(Date.UTC(2026, 1, 1)));
    expect((await limiter.check(check)).allowed).toBe(false);

    now = Date.UTC(2026, 1, 1);
    expect((await limiter.check(check)).allowed).toBe(true);
  });

  it('turns December into January of the next year', () => {
    expect(monthWindowMs(Date.UTC(2026, 11, 31, 23))).toEqual({
      startMs: Date.UTC(2026, 11, 1),
      endMs: Date.UTC(2027, 0, 1),
    });
  });

  it('keeps one count across the boundary a thirty-one-day window would put mid-month', async () => {
    /*
     * The reason the month has its own shape. A thirty-one-day window is a
     * lattice of epoch boundaries, and a thirty-one-day month contains exactly
     * one of them — so a plan cap written as `windowSec` resets partway through
     * January and lets a tenant through twice. The calendar window does not.
     */
    const span = 31 * 24 * 60 * 60 * 1000;
    const boundary = Math.ceil(Date.UTC(2026, 0, 1) / span) * span;
    expect(boundary).toBeGreaterThan(Date.UTC(2026, 0, 1));
    expect(boundary).toBeLessThan(Date.UTC(2026, 1, 1));

    let now = boundary - 1;
    const limiter = memoryRateLimiter(() => now);
    await limiter.check(check);

    now = boundary + 1;
    expect((await limiter.check(check)).allowed).toBe(false);
  });
});

describe('the concurrency case across a window boundary', () => {
  /*
   * The CI failure of 2026-09-14, made deterministic by the clock this
   * implementation takes. The conformance suite's concurrency case counted
   * admitted calls in total, and a burst that straddled a minute boundary
   * admitted thirteen — the fixed-window worst case, not a race. It now counts
   * per window with `tallyWindows`, and these two cases are what show the
   * grouping tells the two situations apart rather than merely tolerating more.
   */
  const LIMIT = 10;
  /** An exact minute, in epoch milliseconds. */
  const BOUNDARY = 1_789_380_000_000;

  it('splits a burst that straddles a boundary into the two windows it landed in', async () => {
    let seen = 0;
    // Three calls in the closing minute, the other forty-seven in the next.
    const limiter = memoryRateLimiter(() => (seen++ < 3 ? BOUNDARY - 1 : BOUNDARY + 1));
    const check = [{ key: 'burst', limit: LIMIT, windowSec: 60 }];

    const results = await Promise.all(Array.from({ length: 50 }, () => limiter.check(check)));

    // The total the old assertion counted, and failed on in CI.
    expect(results.filter((result) => result.allowed)).toHaveLength(13);

    expect(tallyWindows(results).map(({ calls, admitted }) => [calls, admitted])).toEqual([
      [3, 3],
      [47, LIMIT],
    ]);
  });

  it('still shows a single window that admitted more than its limit', () => {
    /*
     * The per-window count is a guard only if it can fail. Eleven admissions
     * that all name one window are what a read-then-write race produces, and
     * the tally has to report them as eleven in one place.
     */
    const resetAt = new Date(BOUNDARY + 60_000);
    const raced = Array.from({ length: LIMIT + 1 }, () => ({
      allowed: true,
      remaining: 0,
      resetAt,
      limit: LIMIT,
      key: 'burst',
    }));

    expect(tallyWindows(raced)).toEqual([
      { resetAt: resetAt.getTime(), calls: LIMIT + 1, admitted: LIMIT + 1 },
    ]);
  });
});

let counter = 0;

/**
 * The shared suite, run against this implementation.
 *
 * It is the same file `packages/db` runs against Postgres. Passing here proves
 * the suite describes the *interface* rather than a backend — which is what
 * makes it usable as the acceptance test for a future Valkey adapter, and what
 * keeps §5.7's "the swap is fifty lines" from being an untested claim.
 */

describeRateLimiter('memory', () => {
  let now = Date.now();

  return {
    limiter: memoryRateLimiter(() => now),
    advancePast: (windowSec) => {
      now += windowSec * 1000 + 1;
      return Promise.resolve();
    },
    freshKey: () => `k-${String(counter++)}`,
  };
});
