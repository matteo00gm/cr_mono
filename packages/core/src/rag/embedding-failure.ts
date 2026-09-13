/**
 * Why a wine failed to index, in terms somebody can act on (P1-50).
 *
 * **Classify before retrying.** Repeating a failure that cannot succeed spends
 * three deliveries delaying the seller's feedback, and parks a wine the seller
 * could fix in a dead-letter queue meant for problems only an operator can. So
 * every failure is sorted before anything is decided: transient ones are
 * retried and, past their limit, set aside behind the alarm; permanent ones are
 * recorded and acknowledged at once.
 *
 * In `core` rather than the worker, because the reason set is the contract
 * between the worker that writes it and the API that publishes it — and the API
 * cannot import the worker. Pure and name-based, so it is tested without AWS.
 */

/**
 * The reasons a wine can be `FAILED` for, as stored in `embedding_error`.
 *
 * Codes, not sentences: the console words them in Italian, and the wording can
 * change without a contract change or a data migration.
 */
export const EMBEDDING_FAILURE_REASONS = [
  'input-rejected',
  'service-unavailable',
  'unknown',
] as const;

export type EmbeddingFailureReason = (typeof EMBEDDING_FAILURE_REASONS)[number];

/**
 * Throttling and server errors a provider call is worth repeating, by name.
 *
 * The Titan adapter's in-call retry ladder reads this same set, so what it
 * retries and what the worker calls transient cannot disagree.
 */
export const RETRYABLE_PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'InternalServerException',
]);

/**
 * Failures that are ours to fix, not the seller's: credentials, permissions, a
 * model not enabled in the region, a quota.
 *
 * **Transient on purpose.** Not worth repeating inside one call, but routed to
 * the DLQ behind its alarm, where somebody who can fix them will look. Calling
 * them permanent would acknowledge every message and mark the whole catalogue
 * failed with a reason no seller could act on, while the alarm stayed silent.
 */
export const OPERATOR_PROVIDER_ERRORS: ReadonlySet<string> = new Set([
  'AccessDeniedException',
  'UnrecognizedClientException',
  'ExpiredTokenException',
  'CredentialsProviderError',
  'ResourceNotFoundException',
  'ModelNotReadyException',
  'ServiceQuotaExceededException',
]);

/** The provider refusing the input itself. Repeating it changes nothing; the text has to. */
export const REJECTED_INPUT_PROVIDER_ERRORS: ReadonlySet<string> = new Set(['ValidationException']);

/** Deliveries an unrecognised provider error gets before it is treated as permanent. */
export const UNKNOWN_FAILURE_DELIVERIES = 2;

/**
 * A failure raised by the provider call itself, with the provider's error as its cause.
 *
 * **What lets a failure be permanent at all.** Only the provider refusing a
 * text can be the seller's to fix; a database connection dropped mid-run, or a
 * bug of ours, never is. Without the wrapper the classifier could not tell
 * them apart, and an outage would mark every wine it touched permanently failed.
 */
export class EmbeddingProviderError extends Error {
  constructor(cause: unknown) {
    super('The embedding provider refused the call', { cause });
    this.name = 'EmbeddingProviderError';
  }
}

export interface EmbeddingFailure {
  readonly kind: 'transient' | 'permanent' | 'unknown';
  readonly reason: EmbeddingFailureReason;
  /** Rethrow, so SQS delivers the message again — and, past its limit, to the DLQ. */
  readonly retry: boolean;
  /** The provider's error name, for an operator's log line. Never stored for the seller. */
  readonly providerError: string | undefined;
}

const nameOf = (error: unknown): string | undefined => {
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' ? name : undefined;
};

/** By name rather than `instanceof`, so a second copy of this module in a test still matches. */
const isProviderError = (error: unknown): error is EmbeddingProviderError =>
  error instanceof Error && error.name === 'EmbeddingProviderError';

const transient = (providerError: string | undefined): EmbeddingFailure => ({
  kind: 'transient',
  reason: 'service-unavailable',
  retry: true,
  providerError,
});

/**
 * What a failure means, given how many times SQS has now delivered its message.
 *
 * - Anything not raised by the provider call is **transient**.
 * - A provider throttle, server error or operator problem is **transient**.
 * - The provider refusing the input is **permanent**: `input-rejected`.
 * - Anything else from the provider is **unknown**: retried on the first
 *   delivery and permanent from the second, so a new error class surfaces as a
 *   reason rather than looping or disappearing into the DLQ.
 */
export const classifyEmbeddingFailure = (error: unknown, deliveries: number): EmbeddingFailure => {
  if (!isProviderError(error)) return transient(undefined);

  const providerError = nameOf(error.cause);
  const name = providerError ?? '';

  if (RETRYABLE_PROVIDER_ERRORS.has(name)) return transient(providerError);
  if (OPERATOR_PROVIDER_ERRORS.has(name)) return transient(providerError);

  if (REJECTED_INPUT_PROVIDER_ERRORS.has(name)) {
    return { kind: 'permanent', reason: 'input-rejected', retry: false, providerError };
  }

  return {
    kind: 'unknown',
    reason: 'unknown',
    retry: deliveries < UNKNOWN_FAILURE_DELIVERIES,
    providerError,
  };
};

/**
 * The reason a wine's grid row shows, derived from its stored status.
 *
 * `null` unless the wine is `FAILED`. A stored value outside the set — a
 * provider error name written before P1-50 — reads as `unknown` rather than
 * publishing a string no contract promised.
 */
export const embeddingFailureOf = (status: {
  readonly state: string;
  readonly error: string | null;
}): EmbeddingFailureReason | null => {
  if (status.state !== 'FAILED') return null;

  const known = EMBEDDING_FAILURE_REASONS.find((reason) => reason === status.error);

  return known ?? 'unknown';
};
