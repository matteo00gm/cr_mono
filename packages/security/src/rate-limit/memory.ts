import { windowOf, type LimitCheck, type LimitResult, type RateLimiter } from './types.js';

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

  /** One counter per key per window, identified by where the window starts. */
  const counterKey = (check: LimitCheck, at: number): string =>
    `${check.key}:${String(windowOf(check, at).startMs)}`;

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
      let tightest: LimitResult | undefined;

      for (const check of checks) {
        const { endMs } = windowOf(check, at);
        const used = counts.get(counterKey(check, at)) ?? 0;
        const resetAt = new Date(endMs);

        if (used >= check.limit) {
          return Promise.resolve({
            allowed: false,
            remaining: 0,
            resetAt,
            limit: check.limit,
            key: check.key,
            retryAfterSec: Math.max(1, Math.ceil((endMs - at) / 1000)),
          } satisfies LimitResult);
        }

        const remaining = check.limit - used - 1;
        if (tightest === undefined || remaining < tightest.remaining) {
          tightest = { allowed: true, remaining, resetAt, limit: check.limit, key: check.key };
        }
      }

      for (const check of checks) {
        const key = counterKey(check, at);
        counts.set(key, (counts.get(key) ?? 0) + 1);
      }

      /*
       * No dimensions means nothing was consulted and nothing refuses. The
       * Postgres implementation throws instead, because there a caller reaching
       * the database with nothing to check is a bug worth surfacing.
       */
      return Promise.resolve(
        tightest ?? { allowed: true, remaining: 0, resetAt: new Date(at), limit: 0, key: '' },
      );
    },
  };
};

export type { LimitCheck, LimitResult, RateLimiter };
