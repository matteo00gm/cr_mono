import { type DomainErrorKind, isDomainError } from '@catalogorosso/core';
import type { ErrorHandler, MiddlewareHandler, NotFoundHandler } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import { getRequestContext } from '../context.js';
import { logger } from './logger.js';

/**
 * The central error handler (P0-55).
 *
 * Two rules, and the second is the one that needs enforcing:
 *
 * 1. A `DomainError` maps to its status and its message reaches the caller.
 * 2. **Everything else becomes a generic 500 carrying only the request id.**
 *    The caller gets the id, the log gets the detail. An unexpected error is by
 *    definition one nobody vetted for disclosure — its message can hold a
 *    connection string, a fragment of another tenant's row, or the shape of the
 *    schema, and a stack trace hands over the file layout of the service.
 */

/**
 * `Record<DomainErrorKind, …>`, so this cannot silently fall behind.
 *
 * Adding a kind in `packages/core` without deciding what it is worth over HTTP
 * is a **typecheck failure**, not a quiet fall-through to 500. Same rule as the
 * P0-49 capability map: the mistake should stop the build.
 */
const STATUS_BY_KIND: Record<DomainErrorKind, ContentfulStatusCode> = {
  /**
   * 404, including for "you may not see this".
   *
   * §3.5: a cross-tenant id must not return 403, because the difference
   * between 403 and 404 tells an attacker that the resource exists.
   */
  not_found: 404,
  unauthenticated: 401,
  forbidden: 403,
  invalid: 422,
  conflict: 409,
  rate_limited: 429,
};

/** What every failing response looks like, for callers and for the typed client (P0-63). */
export interface ErrorBody {
  readonly error: {
    readonly code: DomainErrorKind | 'internal';
    readonly message: string;
    /** Quote this in a bug report; it is the only handle on the log line. */
    readonly requestId: string;
  };
}

/**
 * The message returned when we do not know what happened.
 *
 * Fixed text. Anything derived from the error is a disclosure channel, and
 * "something went wrong" that is always identical is also what makes the
 * account-enumeration assertions in P0-46 possible.
 */
const GENERIC_MESSAGE = 'An unexpected error occurred.';

const requestId = (): string => getRequestContext()?.requestId ?? 'unknown';

const body = (code: ErrorBody['error']['code'], message: string): ErrorBody => ({
  error: { code, message, requestId: requestId() },
});

/**
 * Turns a thrown non-`Error` into an `Error`, so `onError` ever sees it.
 *
 * **Hono rethrows anything that is not an `Error` instance rather than calling
 * the error handler** — `compose.js` guards its catch with `err instanceof
 * Error && onError`, and `hono-base.js#handleError` does the same. Verified
 * against the pinned 4.13.5 source, because this is not documented.
 *
 * The consequence is the reason this middleware exists. `throw 'oops'` and
 * `throw { code: 42 }` are legal JavaScript, and third-party libraries do it:
 * a rejected value from a driver, a string thrown by a validator. Such a value
 * escapes the app entirely, so the Lambda invocation fails and the caller gets
 * the runtime's own 502 — no error envelope, no request id, no log line from
 * `errorHandler`, and the raw thrown value potentially in the response. Every
 * disclosure guarantee below is bypassed by a `throw` of the wrong type.
 *
 * **Register it immediately after `requestContext()` and before every route.**
 * Inside, so the conversion happens while the request context is still open and
 * the resulting 500 carries a real request id; outside every route, so it
 * covers all of them.
 */
export const normaliseThrown = (): MiddlewareHandler => async (_c, next) => {
  try {
    await next();
  } catch (thrown) {
    if (thrown instanceof Error) throw thrown;
    // `cause` carries the original to the log, where the handler prints the
    // whole chain — the response still gets nothing but the request id.
    throw new Error('Non-Error value thrown', { cause: thrown });
  }
};

export const errorHandler: ErrorHandler = (error, c) => {
  if (isDomainError(error)) {
    /*
     * `warn`, not `error`: a 404 or a 409 is the system working. Logging
     * expected outcomes at error level is how an alert on the error rate stops
     * meaning anything, and then how a real incident goes unnoticed.
     */
    logger.warn({ kind: error.kind, err: error }, 'domain error');
    return c.json(body(error.kind, error.message), STATUS_BY_KIND[error.kind]);
  }

  /*
   * The whole error, including the cause chain, goes to the log — and nothing
   * but the request id comes back to the caller.
   */
  logger.error({ err: error }, 'unhandled error');
  return c.json(body('internal', GENERIC_MESSAGE), 500);
};

/**
 * 404 in the same envelope as every other failure.
 *
 * Hono's default is the string `404 Not Found`, which means a client parsing
 * responses as JSON gets a syntax error for the single most common failure —
 * and reports it as "the API returned garbage" rather than "that route does not
 * exist".
 */
export const notFoundHandler: NotFoundHandler = (c) => c.json(body('not_found', 'Not found'), 404);
