/**
 * Domain errors (P0-55).
 *
 * **These carry no HTTP status codes, deliberately.** `packages/core` is kept
 * free of HTTP by the P0-09 boundary rule, and the reason is not purity: the
 * same failure means different things to different callers. "This tenant has no
 * such product" is a 404 to the dashboard API and a dropped SQS message to the
 * worker, and a status code baked into the throw site forces the second caller
 * to unpick a decision the first one made. Core says *what went wrong*;
 * `apps/api/src/middleware/error.ts` decides what that is worth over HTTP.
 *
 * **A `DomainError`'s message is part of the API contract.** It is written for
 * the caller and is returned to them verbatim — so it must never contain a
 * secret, a raw database error, another tenant's data, or anything that answers
 * a question the caller was not entitled to ask. Everything that is *not* a
 * `DomainError` is treated as unexpected and its message never leaves the
 * process. That asymmetry is the whole safety property here, and it is what
 * lets the error handler be generic without being useless.
 */

/**
 * The kinds, as a closed list.
 *
 * Exported as a value so the HTTP mapping can be a `Record<DomainErrorKind, …>`
 * — which makes adding a kind without deciding its status a typecheck failure
 * rather than a silent fall-through to 500. Same rule as the P0-49 capability
 * map: a missing entry must fail the build, not default to something.
 */
export const DOMAIN_ERROR_KINDS = [
  /** The thing does not exist, or the caller may not know that it does. */
  'not_found',
  /** The caller is not authenticated at all. */
  'unauthenticated',
  /** Authenticated, but not permitted. */
  'forbidden',
  /** The request was understood and is not valid. */
  'invalid',
  /** The request conflicts with current state — a duplicate, a lost race. */
  'conflict',
  /** The caller is going too fast. */
  'rate_limited',
] as const;

export type DomainErrorKind = (typeof DOMAIN_ERROR_KINDS)[number];

/**
 * A failure we anticipated, described in terms of the domain.
 *
 * `cause` exists so the underlying error can travel to the log without
 * travelling to the response — the handler reads `message` for the caller and
 * the whole chain for the log line.
 */
export class DomainError extends Error {
  readonly kind: DomainErrorKind;

  constructor(kind: DomainErrorKind, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.kind = kind;
    // Without this, `error.name` is "Error" for every subclass, because the
    // class name is not carried onto instances by `extends` alone.
    this.name = new.target.name;
  }
}

/**
 * Not found — and the default answer for "you may not see this", too.
 *
 * §3.5 requires a cross-tenant id to return 404 rather than 403, so that the
 * existence of another tenant's resource is not something an attacker can
 * probe for. `ForbiddenError` is for cases where the caller already knows the
 * thing exists — refusing to demote the last OWNER, say.
 */
export class NotFoundError extends DomainError {
  constructor(message = 'Not found', options?: { cause?: unknown }) {
    super('not_found', message, options);
  }
}

export class UnauthenticatedError extends DomainError {
  constructor(message = 'Authentication required', options?: { cause?: unknown }) {
    super('unauthenticated', message, options);
  }
}

export class ForbiddenError extends DomainError {
  constructor(message = 'Not permitted', options?: { cause?: unknown }) {
    super('forbidden', message, options);
  }
}

export class InvalidRequestError extends DomainError {
  constructor(message = 'Invalid request', options?: { cause?: unknown }) {
    super('invalid', message, options);
  }
}

export class ConflictError extends DomainError {
  constructor(message = 'Conflict', options?: { cause?: unknown }) {
    super('conflict', message, options);
  }
}

export class RateLimitedError extends DomainError {
  constructor(message = 'Too many requests', options?: { cause?: unknown }) {
    super('rate_limited', message, options);
  }
}

/**
 * `instanceof` is not enough on its own.
 *
 * A Lambda bundle can end up with two copies of this module — a workspace link
 * beside a bundled copy, or two versions during a partial deploy — and then
 * `instanceof` is false for an object that is a `DomainError` in every way that
 * matters. The consequence is not cosmetic: a genuine 404 would be reported as
 * an unexpected 500, and the caller's message would be swallowed. So the check
 * is structural, and `instanceof` is only the fast path.
 */
export const isDomainError = (value: unknown): value is DomainError =>
  value instanceof DomainError ||
  (value instanceof Error &&
    'kind' in value &&
    typeof value.kind === 'string' &&
    (DOMAIN_ERROR_KINDS as readonly string[]).includes(value.kind));
