/**
 * The rate limiter's contract (P2-01).
 *
 * Backend-agnostic, and the interface earns its place even though Postgres is
 * the permanent home at this scale (§5.7): it costs nothing now and keeps a
 * future backend swap a config change rather than a rewrite of a
 * security-critical path. What makes that claim true rather than aspirational
 * is the shared conformance suite — any implementation that passes it is a
 * drop-in, and there is one test file rather than two that drift.
 */

export interface LimitCheck {
  /**
   * Dimension and subject in one string: `ip:<hash>`, `session:<id>`,
   * `tenant:<id>:min`.
   *
   * The dimension is part of the key rather than a separate field because the
   * limiter counts things that belong to no tenant — an address hammering an
   * invalid widget key, for instance — so there is no column to scope by and
   * the key format is what provides isolation.
   */
  readonly key: string;
  /** Requests permitted per window. */
  readonly limit: number;
  /** Window length in seconds. */
  readonly windowSec: number;
}

export interface LimitResult {
  readonly allowed: boolean;
  /** How many remain in the tightest window that was checked. */
  readonly remaining: number;
  /** When that window closes. */
  readonly resetAt: Date;
  /** Present only on a rejection, for the `Retry-After` header. */
  readonly retryAfterSec?: number | undefined;
}

export interface RateLimiter {
  /**
   * Checks and consumes across every dimension at once, **all-or-nothing**.
   *
   * The array and the atomicity are the same decision. Consuming from three
   * buckets and then failing on the fourth would let a caller who is already
   * blocked keep draining everybody else's budget — a rejected request would
   * still cost the tenant and the IP a token each, so an attacker held off by
   * one dimension could exhaust the others for free.
   *
   * A rejection therefore consumes nothing, and the result describes the
   * dimension that refused rather than an aggregate.
   */
  check(checks: readonly LimitCheck[]): Promise<LimitResult>;
}

/**
 * The window a fixed-window counter falls into, computed from a clock.
 *
 * Exported because the Postgres implementation computes this **in SQL** and the
 * memory implementation computes it here, and the two must agree exactly or the
 * conformance suite passes against one and lies about the other. Sharing the
 * arithmetic is what makes them comparable.
 */
export const windowStartMs = (nowMs: number, windowSec: number): number =>
  nowMs - (nowMs % (windowSec * 1000));
