/**
 * Log redaction (P0-56).
 *
 * **An allowlist, not a denylist**, and that is the entire design. A denylist
 * protects the fields somebody remembered on the day they wrote it; the next
 * field added to a payload leaks by default, and nobody finds out until it is
 * already in CloudWatch. Given that `sk_live_` keys, JWTs and visitors' own
 * messages all flow through this system, the default has to be to redact — so
 * a key nobody has thought about is hidden rather than published, and adding a
 * field to a log line is a deliberate act.
 *
 * Two layers, because neither is sufficient alone:
 *
 * 1. **Keys.** Anything not in `SAFE_KEYS` becomes `[redacted]`, at any depth.
 *    The key *name* survives, so a log line still says a `password` field was
 *    present — which is what makes a debugging session possible at all.
 * 2. **Values.** Every string that does survive is pattern-scrubbed, because an
 *    allowed key can still carry a secret: `msg` is allowed, and
 *    `"failed with token sk_live_…"` is a message somebody will write.
 *
 * Nothing here imports pino. These are plain functions so P0-53's `audit()` can
 * scrub its metadata through exactly the same code — a second implementation
 * for audit rows is how the two drift.
 */

export const REDACTED = '[redacted]';

/** Guards against a self-referential object logged by accident. */
const CIRCULAR = '[circular]';

/** Nesting past this is almost always an accident, and it is unreadable anyway. */
const MAX_DEPTH = 8;
const TOO_DEEP = '[too deep]';

/**
 * The keys whose values may be logged.
 *
 * Kept short on purpose. Every addition is a decision that this field can never
 * hold anything sensitive **for any caller**, since the allowlist applies at
 * every depth of every logged object — so a key added for one call site governs
 * every other use of that name.
 *
 * Notably absent, and each for a reason:
 *
 * - `message` — a visitor's chat message is a `message`, and that is PII (§3.7).
 *   Error messages reach the log through `serialiseError` instead, which is a
 *   path that only errors take.
 * - `code` — an error code is harmless, but an email verification code is not
 *   (P0-64), and one allowlist cannot tell them apart by name.
 * - `email`, `name`, `token`, `key` — the obvious ones, listed here only so the
 *   next reader can see they were considered rather than missed.
 */
export const SAFE_KEYS: ReadonlySet<string> = new Set([
  // pino's own envelope.
  'level',
  'time',
  'pid',
  'hostname',
  'msg',
  'v',

  // The request context (P0-55). These are the whole point of the log line.
  'requestId',
  'tenantId',
  'userId',
  'traceId',

  // The request completion line. `route` is a template, never a concrete URL.
  'method',
  'route',
  'status',
  'durationMs',

  // Error classification — the serialised error itself, and its domain kind.
  'err',
  'kind',
  'type',
  'stack',

  // Counters and outcomes. Numbers about work done, never about who did it.
  'count',
  'attempt',
  'limit',
  'remaining',
  'durationMsTotal',
]);

/**
 * Value patterns, applied to every string that survives the key allowlist.
 *
 * The list is ordered, and the order matters: credentials inside a URL are
 * removed before the email pattern runs, or `hunter2@db.internal` in a
 * connection string is scrubbed as though it were an address and the result is
 * mangled rather than clean. Both outcomes hide the secret; only one is
 * readable afterwards.
 */
const PATTERNS: readonly (readonly [RegExp, string])[] = [
  /*
   * `scheme://user:password@host` — the shape of every connection string this
   * system holds, and the exact thing a driver puts in an error message.
   */
  [/([a-z][a-z0-9+.-]*:\/\/)[^\s/@:]+:[^\s/@]+@/gi, `$1${REDACTED}@`],

  /** `Authorization: Bearer …`, wherever a header ends up logged. */
  [/\bBearer\s+[\w\-._~+/]+=*/gi, `Bearer ${REDACTED}`],

  /**
   * A JWT. Matched on the `eyJ` prefix, which is `{"` base64-encoded, so it is
   * the start of every JSON-header token rather than a guess.
   */
  [/\beyJ[\w-]{5,}\.[\w-]+\.[\w-]*/g, REDACTED],

  /**
   * Prefixed API keys — ours (`sk_live_`, `pk_live_`) and Stripe's, which share
   * the shape. Deliberately broader than the P0-08 gitleaks rules: those need a
   * 24-character floor so truncated examples in documentation stay legible,
   * whereas here a short match costs nothing and a missed one is a leak.
   */
  [/\b[a-z]{2,5}_(?:live|test)_[A-Za-z0-9]{8,}/g, REDACTED],

  /** Email addresses, which are PII wherever they appear (§3.7). */
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+/g, REDACTED],
];

/** Applies every value pattern. Exported because P2-33 scrubs prompts too. */
export const scrubString = (value: string): string =>
  PATTERNS.reduce((text, [pattern, replacement]) => text.replace(pattern, replacement), value);

/**
 * An error, reduced to the three fields worth having.
 *
 * Errors take their own path rather than going through the key allowlist,
 * because `message` and `stack` are exactly the fields that must survive for a
 * log to be usable and exactly the ones that cannot be allowlisted generally —
 * a `message` key on an arbitrary object is as likely to be a visitor's chat
 * message as an error string. Both are scrubbed, since a driver error routinely
 * quotes the connection string that failed.
 *
 * `cause` is followed, because `normaliseThrown` (P0-55) puts the original
 * thrown value there and that is often the only description of what happened.
 */
export const serialiseError = (error: unknown): unknown => {
  if (!(error instanceof Error)) return redactValue(error);

  return {
    type: error.name,
    message: scrubString(error.message),
    stack: error.stack === undefined ? undefined : scrubString(error.stack),
    ...('kind' in error ? { kind: error.kind } : {}),
    ...(error.cause === undefined ? {} : { cause: serialiseError(error.cause) }),
  };
};

const redactAt = (value: unknown, depth: number, seen: Set<object>): unknown => {
  if (typeof value === 'string') return scrubString(value);
  if (value === null || typeof value !== 'object') return value;

  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return serialiseError(value);

  if (seen.has(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TOO_DEEP;

  seen.add(value);
  try {
    if (Array.isArray(value)) return value.map((item) => redactAt(item, depth + 1, seen));

    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        // The key name survives even when its value does not: a line saying a
        // `password` field was present is far more use than one that dropped it.
        SAFE_KEYS.has(key) ? redactAt(item, depth + 1, seen) : REDACTED,
      ]),
    );
  } finally {
    // Removed on the way out, so a value referenced twice in a tree is not
    // mistaken for a cycle. Only the current path is tracked.
    seen.delete(value);
  }
};

/**
 * The allowlist walk.
 *
 * Top-level strings are scrubbed but not redacted wholesale: this is called
 * with a log object, and the caller's own `msg` is not a field lookup.
 */
export const redactValue = (value: unknown): unknown => redactAt(value, 0, new Set());

/** Pino's `formatters.log` hook: the merged object of every log call. */
export const redactLogObject = (object: Record<string, unknown>): Record<string, unknown> =>
  redactAt(object, 0, new Set()) as Record<string, unknown>;
