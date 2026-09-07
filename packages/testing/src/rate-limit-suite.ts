import { describe, expect, it } from 'vitest';

/**
 * The limiter's shape, restated rather than imported from
 * `@catalogorosso/security`.
 *
 * **Structural on purpose, and a build cycle is what forced the question.**
 * This package already depends on `@catalogorosso/db`, and `packages/security`
 * depends on *this* one for the redaction fixtures — so importing security here
 * closes a loop Turbo refuses to build.
 *
 * Restating it turns out to be the better shape anyway. A conformance suite
 * that structurally types what it exercises is one that a future adapter can
 * satisfy without this package knowing the adapter exists, which is the whole
 * claim the suite is meant to keep honest. The two definitions are kept in
 * agreement by `packages/security`'s own run of this suite: if they drift, its
 * limiter stops satisfying this signature and the compiler says so.
 */
export interface LimitCheck {
  readonly key: string;
  readonly limit: number;
  readonly windowSec: number;
}

export interface LimitResult {
  readonly allowed: boolean;
  readonly remaining: number;
  readonly resetAt: Date;
  readonly retryAfterSec?: number | undefined;
}

export interface RateLimiter {
  check(checks: readonly LimitCheck[]): Promise<LimitResult>;
}

/**
 * The shared conformance suite for `RateLimiter` (P2-03).
 *
 * **Written against the interface, not against an implementation**, and that is
 * the point rather than a style preference. §5.7 argues that moving off
 * Postgres is a fifty-line change; a suite that only ever ran against Postgres
 * would slowly become a description of Postgres, and the claim would be
 * untestable at the moment somebody needed it. Any implementation that passes
 * this is a drop-in, and there is one file rather than two that drift.
 *
 * It lives in `packages/testing` because both implementations must run it and
 * neither package may import the other: `packages/security` holds the interface
 * and has no database, `packages/db` holds the statements. This is the only
 * place that can see both.
 */

export interface RateLimiterFixture {
  readonly limiter: RateLimiter;
  /**
   * Moves the clock past a window boundary.
   *
   * A port rather than fake timers: the Postgres implementation computes its
   * window **in SQL from `now()`**, deliberately, so a JavaScript clock stub
   * cannot move it. An implementation that cannot advance says so by waiting.
   */
  readonly advancePast: (windowSec: number) => Promise<void>;
  /** A key nothing else in the run will touch. */
  readonly freshKey: () => string;
}

const one = (key: string, limit: number, windowSec = 60): LimitCheck[] => [
  { key, limit, windowSec },
];

/**
 * Runs the suite against one implementation.
 *
 * @param name shown in the test output, so a failure says which backend broke.
 * @param makeFixture called once per test, so no case can leak state into
 *   another — the concurrency case in particular would otherwise be poisoned by
 *   whatever ran before it.
 */
export const describeRateLimiter = (
  name: string,
  makeFixture: () => Promise<RateLimiterFixture> | RateLimiterFixture,
): void => {
  describe(`RateLimiter conformance: ${name}`, () => {
    it('allows exactly up to the limit', async () => {
      const { limiter, freshKey } = await makeFixture();
      const key = freshKey();

      for (let i = 0; i < 3; i += 1) {
        const result = await limiter.check(one(key, 3));
        expect(result.allowed, `request ${String(i + 1)} of 3`).toBe(true);
      }
    });

    it('rejects at limit + 1', async () => {
      const { limiter, freshKey } = await makeFixture();
      const key = freshKey();

      await limiter.check(one(key, 2));
      await limiter.check(one(key, 2));

      const result = await limiter.check(one(key, 2));
      expect(result.allowed).toBe(false);
    });

    it('decrements remaining', async () => {
      const { limiter, freshKey } = await makeFixture();
      const key = freshKey();

      expect((await limiter.check(one(key, 3))).remaining).toBe(2);
      expect((await limiter.check(one(key, 3))).remaining).toBe(1);
      expect((await limiter.check(one(key, 3))).remaining).toBe(0);
    });

    it('reports when the window closes, and a retry-after on rejection', async () => {
      const { limiter, freshKey } = await makeFixture();
      const key = freshKey();

      const allowed = await limiter.check(one(key, 1));
      expect(allowed.resetAt.getTime()).toBeGreaterThan(Date.now());

      const rejected = await limiter.check(one(key, 1));
      expect(rejected.allowed).toBe(false);

      // The value a `Retry-After` header carries. At least 1, because 0 tells a
      // client to retry immediately and produces a hot loop against the limit.
      expect(rejected.retryAfterSec ?? 0).toBeGreaterThanOrEqual(1);
      expect(rejected.retryAfterSec ?? 0).toBeLessThanOrEqual(60);
    });

    it('resets when the window rolls over', async () => {
      const { limiter, advancePast, freshKey } = await makeFixture();
      const key = freshKey();

      await limiter.check(one(key, 1, 1));
      expect((await limiter.check(one(key, 1, 1))).allowed).toBe(false);

      await advancePast(1);

      expect((await limiter.check(one(key, 1, 1))).allowed).toBe(true);
    });

    it('counts each key separately', async () => {
      const { limiter, freshKey } = await makeFixture();
      const [a, b] = [freshKey(), freshKey()];

      await limiter.check(one(a, 1));

      // Exhausting one dimension must not touch another. The obvious way to get
      // this wrong is a shared counter keyed by window alone.
      expect((await limiter.check(one(a, 1))).allowed).toBe(false);
      expect((await limiter.check(one(b, 1))).allowed).toBe(true);
    });

    it('consumes nothing when any dimension refuses', async () => {
      const { limiter, freshKey } = await makeFixture();
      const [tight, loose] = [freshKey(), freshKey()];

      // Exhaust the tight dimension on its own.
      await limiter.check(one(tight, 1));

      const rejected = await limiter.check([
        { key: tight, limit: 1, windowSec: 60 },
        { key: loose, limit: 10, windowSec: 60 },
      ]);
      expect(rejected.allowed).toBe(false);

      /*
       * **The all-or-nothing rule, and the reason the interface has it.** The
       * rejected call must not have consumed from `loose` — otherwise an
       * attacker already blocked by their own IP limit could still drain the
       * tenant's budget with every rejected request, for free.
       *
       * Ten remain because the rejection cost nothing; nine would mean partial
       * consumption.
       */
      expect((await limiter.check(one(loose, 10))).remaining).toBe(9);
    });

    it('reports the tightest dimension, not the loosest', async () => {
      const { limiter, freshKey } = await makeFixture();
      const [tight, loose] = [freshKey(), freshKey()];

      const result = await limiter.check([
        { key: tight, limit: 2, windowSec: 60 },
        { key: loose, limit: 100, windowSec: 60 },
      ]);

      // A caller shown 99 would think it had room it does not have.
      expect(result.remaining).toBe(1);
    });

    it('lets exactly the limit through under concurrency', async () => {
      const { limiter, freshKey } = await makeFixture();
      const key = freshKey();

      /*
       * **The case the whole design exists for.** Fifty simultaneous calls
       * against a limit of ten: a read-then-write implementation lets far more
       * than ten through, because every caller reads the same count before any
       * of them writes.
       *
       * This is why the Postgres statement is a single
       * `INSERT ... ON CONFLICT DO UPDATE ... RETURNING` rather than a SELECT
       * followed by an UPDATE — and it is why this assertion belongs in a
       * suite that runs against a real database, where the concurrency is real.
       */
      const results = await Promise.all(
        Array.from({ length: 50 }, () => limiter.check(one(key, 10))),
      );

      const allowed = results.filter((r: LimitResult) => r.allowed);
      expect(allowed).toHaveLength(10);
    });
  });
};
