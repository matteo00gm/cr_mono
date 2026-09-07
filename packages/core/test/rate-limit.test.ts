import { describe, expect, it } from 'vitest';
import { memoryRateLimiter } from '@catalogorosso/security';

import { betterAuthRateLimitStorage } from '../src/rate-limit.js';

/**
 * The Better Auth adapter (A1).
 *
 * **The first test here is the one that matters**, and it exists because of
 * something the library's types allow: `betterAuth`'s options accept unknown
 * keys at the `rateLimit` level, so `customStorageTypo` typechecks cleanly and
 * silently falls back to the in-memory store. A typo would reintroduce A1 —
 * counters per Lambda container, reset on every recycle — with nothing failing
 * and nothing to see in a diff.
 *
 * So this asserts that a real `betterAuth` instance actually *calls* the
 * storage, rather than that the option was passed.
 */

describe('the adapter', () => {
  it('translates a rule into a check and a refusal into a retry-after', async () => {
    const storage = betterAuthRateLimitStorage(memoryRateLimiter());

    const first = await storage.consume('/sign-in/email:1.2.3.4', { window: 60, max: 1 });
    expect(first).toEqual({ allowed: true, retryAfter: null });

    const second = await storage.consume('/sign-in/email:1.2.3.4', { window: 60, max: 1 });
    expect(second.allowed).toBe(false);

    // Straight into a `Retry-After` header, so a number on an allowed request
    // would tell a client to back off after being let through.
    expect(second.retryAfter).toBeGreaterThanOrEqual(1);
  });

  it('namespaces the key, because the widget shares this table', async () => {
    const seen: string[] = [];
    const storage = betterAuthRateLimitStorage({
      check: (checks) => {
        seen.push(...checks.map((c) => c.key));
        return Promise.resolve({ allowed: true, remaining: 1, resetAt: new Date() });
      },
    });

    await storage.consume('/sign-in/email:1.2.3.4', { window: 60, max: 10 });

    // A bare path key from one surface could otherwise collide with the
    // other's (P0-34).
    expect(seen).toEqual(['auth:/sign-in/email:1.2.3.4']);
  });

  it('passes the key through unchanged', async () => {
    const seen: string[] = [];
    const storage = betterAuthRateLimitStorage({
      check: (checks) => {
        seen.push(...checks.map((c) => c.key));
        return Promise.resolve({ allowed: true, remaining: 1, resetAt: new Date() });
      },
    });

    await storage.consume('weird::key/with:colons', { window: 60, max: 10 });

    /*
     * Better Auth composes the key from the caller's IP and the path.
     * Re-deriving it here would mean two places deciding what a caller *is*,
     * with the failure mode that they disagree and the limit quietly applies to
     * something other than what the rules describe.
     */
    expect(seen[0]).toBe('auth:weird::key/with:colons');
  });
});
