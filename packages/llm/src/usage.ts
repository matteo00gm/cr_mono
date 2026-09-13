/**
 * Tokens spent on one pairing, as every adapter reports them (P1-42).
 *
 * Reported through a callback rather than a chunk, because it is operator data:
 * `usage_events` records it per turn so gross margin per tenant is a query
 * (§4.5), and the live tests read the cache fields to prove the prefix cache
 * hits. A visitor's stream has no use for it.
 */
export interface PairingUsage {
  readonly inputTokens: number;
  readonly outputTokens: number;
  /** Input served from the provider's prompt cache. Zero on a cold call. */
  readonly cacheReadInputTokens: number;
  /** Input written to the cache on this call. */
  readonly cacheWriteInputTokens: number;
}
