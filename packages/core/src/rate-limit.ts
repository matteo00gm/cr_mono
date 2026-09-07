import type { RateLimiter } from '@catalogorosso/security';

import type { RateLimitStorage } from './auth.js';

/**
 * Adapts a `RateLimiter` to Better Auth's storage contract (A1).
 *
 * Two vocabularies for the same idea, and the adapter is where they meet: ours
 * takes an array of dimensions and is all-or-nothing; Better Auth passes one
 * key and a rule, and wants `{ allowed, retryAfter }`.
 *
 * **The key is passed through unchanged.** Better Auth composes it from the
 * caller's IP and the path, and re-deriving it here would mean two places
 * deciding what a caller is — with the failure mode that they disagree and the
 * limit silently applies to something other than what the rules describe.
 */
export const betterAuthRateLimitStorage = (limiter: RateLimiter): RateLimitStorage => ({
  async consume(key, rule) {
    const result = await limiter.check([
      // Namespaced, because this table also holds the widget's buckets (P0-34)
      // and a bare path key from one surface could otherwise collide with the
      // other's.
      { key: `auth:${key}`, limit: rule.max, windowSec: rule.window },
    ]);

    return {
      allowed: result.allowed,
      /*
       * `null` on success is Better Auth's shape, not ours — it puts the value
       * straight into a `Retry-After` header, where a number on an allowed
       * request would tell a client to back off after being let through.
       */
      retryAfter: result.allowed ? null : (result.retryAfterSec ?? rule.window),
    };
  },
});
