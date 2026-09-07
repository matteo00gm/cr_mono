import { describe, expect, it } from 'vitest';

import { describeRateLimiter } from '@catalogorosso/testing';

import { memoryRateLimiter, windowStartMs } from '../src/rate-limit/index.js';

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
