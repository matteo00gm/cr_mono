import { windowStartMs, type LimitCheck, type LimitResult, type RateLimiter } from './types.js';

/**
 * An in-process limiter (P2-01).
 *
 * **Not for production, and the reason is the whole of A1.** Better Auth's own
 * default store is exactly this shape, and in Lambda it means *per container*:
 * with N warm containers an attacker gets N times each configured limit, and a
 * container recycle resets the counter to zero — so lockouts and backoff cannot
 * be reasoned about at all.
 *
 * It exists for two honest uses. It is the second implementation the
 * conformance suite runs against, which is what keeps that suite from silently
 * becoming a description of Postgres; and it lets a local run exercise the
 * limiting path without a database.
 *
 * **It never discards closed windows**, so the map grows with the number of
 * distinct keys seen. Stated rather than papered over with a prune that would
 * be untested: for a test run and a local process this is bounded by the run
 * itself, and anything long-lived enough to care should be using the Postgres
 * implementation, where P2-14's sweep is the answer.
 */
export const memoryRateLimiter = (now: () => number = Date.now): RateLimiter => {
  const counts = new Map<string, number>();

  return {
    check(checks) {
      const at = now();

      /*
       * Two passes, and the split is the all-or-nothing rule. The first decides
       * without writing anything; only if every dimension passes does the
       * second consume. A single pass that incremented as it went would leave
       * partial consumption behind on the rejection path — the exact behaviour
       * the interface forbids.
       */
      let tightest: { remaining: number; resetAt: Date } | undefined;

      for (const check of checks) {
        const start = windowStartMs(at, check.windowSec);
        const used = counts.get(`${check.key}:${String(start)}`) ?? 0;
        const resetAt = new Date(start + check.windowSec * 1000);

        if (used >= check.limit) {
          return Promise.resolve({
            allowed: false,
            remaining: 0,
            resetAt,
            retryAfterSec: Math.max(1, Math.ceil((resetAt.getTime() - at) / 1000)),
          } satisfies LimitResult);
        }

        const remaining = check.limit - used - 1;
        if (tightest === undefined || remaining < tightest.remaining) {
          tightest = { remaining, resetAt };
        }
      }

      for (const check of checks) {
        const key = `${check.key}:${String(windowStartMs(at, check.windowSec))}`;
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      return Promise.resolve({
        allowed: true,
        remaining: tightest?.remaining ?? 0,
        resetAt: tightest?.resetAt ?? new Date(at),
      } satisfies LimitResult);
    },
  };
};

export type { LimitCheck, LimitResult, RateLimiter };
