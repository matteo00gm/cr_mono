import {
  ConflictError,
  DOMAIN_ERROR_KINDS,
  DomainError,
  ForbiddenError,
  InvalidRequestError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  type DomainErrorKind,
} from '@catalogorosso/core';
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import {
  errorHandler,
  normaliseThrown,
  notFoundHandler,
  type ErrorBody,
} from '../src/middleware/error.js';
import { logger, REQUEST_ID_HEADER, requestContext } from '../src/middleware/logger.js';

/**
 * The central error handler (P0-55).
 *
 * The property under test throughout is the asymmetry: a `DomainError` was
 * written for the caller and reaches them; anything else was not, and nothing
 * of it escapes but the request id.
 */

/** An app that throws whatever it is handed, through the real middleware stack. */
const appThrowing = (error: unknown): Hono => {
  const app = new Hono();
  app.use('*', requestContext());
  app.use('*', normaliseThrown());
  app.onError(errorHandler);
  app.notFound(notFoundHandler);
  app.get('/boom', () => {
    throw error;
  });
  return app;
};

const bodyOf = async (response: Response): Promise<ErrorBody> =>
  (await response.json()) as ErrorBody;

beforeEach(() => {
  // The handler logs every failure; the suite deliberately produces dozens.
  // Restored rather than merely re-spied, or the call counts accumulate across
  // tests and every `toHaveBeenCalledTimes` becomes a running total.
  vi.restoreAllMocks();
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

describe('domain errors', () => {
  const cases: readonly [DomainError, DomainErrorKind, number][] = [
    [new NotFoundError(), 'not_found', 404],
    [new UnauthenticatedError(), 'unauthenticated', 401],
    [new ForbiddenError(), 'forbidden', 403],
    [new InvalidRequestError(), 'invalid', 422],
    [new ConflictError(), 'conflict', 409],
    [new RateLimitedError(), 'rate_limited', 429],
  ];

  it.each(cases)('%s maps to its status', async (error, kind, status) => {
    const response = await appThrowing(error).request('/boom');

    expect(response.status).toBe(status);
    expect((await bodyOf(response)).error.code).toBe(kind);
  });

  it('covers every kind the domain declares', () => {
    /*
     * The table above is hand-written, so it can fall behind `packages/core`.
     * The compiler already refuses a `Record<DomainErrorKind, …>` with a
     * missing entry — this asserts the *test* table is complete too, so a new
     * kind cannot arrive with a mapping nobody exercised.
     */
    expect(cases.map(([, kind]) => kind).sort()).toEqual([...DOMAIN_ERROR_KINDS].sort());
  });

  it('returns the message, because a domain message is written for the caller', async () => {
    const response = await appThrowing(new NotFoundError('No such wine in this catalogue')).request(
      '/boom',
    );

    expect((await bodyOf(response)).error.message).toBe('No such wine in this catalogue');
  });

  it('logs at warn, not error', async () => {
    /*
     * A 404 or a 409 is the system working. Logging expected outcomes at error
     * level is how an alert on the error rate stops meaning anything — and
     * then how a real incident goes unnoticed inside the noise.
     */
    await appThrowing(new ConflictError()).request('/boom');

    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.error).not.toHaveBeenCalled();
  });
});

describe('unexpected errors', () => {
  const secret = 'postgres://app_rw:hunter2@db.internal:5432/sommelier';

  it('become a generic 500', async () => {
    const response = await appThrowing(new Error(secret)).request('/boom');

    expect(response.status).toBe(500);
    expect((await bodyOf(response)).error.code).toBe('internal');
  });

  it('never leak the message', async () => {
    /*
     * The reason the generic body exists. An unexpected error is by definition
     * one nobody vetted for disclosure: a connection string, a fragment of
     * another tenant's row, or the shape of the schema can all end up in
     * `.message`, and a driver error routinely does.
     */
    const response = await appThrowing(new Error(secret)).request('/boom');
    const raw = JSON.stringify(await bodyOf(response));

    expect(raw).not.toContain('hunter2');
    expect(raw).not.toContain('db.internal');
  });

  it('never leak a stack trace', async () => {
    // A stack hands over the file layout of the service, which is a map for
    // whoever is probing it.
    const response = await appThrowing(new Error('boom')).request('/boom');
    const raw = JSON.stringify(await bodyOf(response));

    expect(raw).not.toContain('.ts:');
    expect(raw).not.toContain('at ');
  });

  it('carry the request id, which is the only handle the caller gets', async () => {
    const response = await appThrowing(new Error('boom')).request('/boom');

    expect((await bodyOf(response)).error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('log the whole error, including what the response withheld', async () => {
    const error = new Error(secret);
    await appThrowing(error).request('/boom');

    expect(logger.error).toHaveBeenCalledWith({ err: error }, 'unhandled error');
  });

  it.each([
    ['a string', 'oops'],
    ['an object', { code: 42 }],
    ['null', null],
  ])('reach the handler even when %s was thrown', async (_label, thrown) => {
    /*
     * Hono rethrows anything that is not an `Error` rather than calling
     * `onError` (verified in `compose.js` at the pinned 4.13.5). Without
     * `normaliseThrown` these escape the app entirely: the Lambda invocation
     * fails, the caller gets the runtime's raw 502, and the envelope, the
     * request id and every disclosure rule below are bypassed at once by a
     * `throw` of the wrong type. Libraries do this — a string thrown by a
     * validator, a rejected non-Error from a driver.
     */
    const response = await appThrowing(thrown).request('/boom');

    expect(response.status).toBe(500);
    expect((await bodyOf(response)).error).toMatchObject({ code: 'internal' });
  });

  it('keep a thrown non-Error out of the response but carry it to the log', async () => {
    await appThrowing('postgres://app_rw:hunter2@db.internal/x').request('/boom');

    const logged = vi.mocked(logger.error).mock.calls[0]?.[0] as { err: Error } | undefined;

    expect(logged?.err.cause).toBe('postgres://app_rw:hunter2@db.internal/x');
  });
});

describe('the request id', () => {
  it('is echoed on the response header and matches the body', async () => {
    const response = await appThrowing(new Error('boom')).request('/boom');

    expect(response.headers.get(REQUEST_ID_HEADER)).toBe((await bodyOf(response)).error.requestId);
  });

  it('is present on successful responses too', async () => {
    const response = await createApp().request('/v1/health');

    expect(response.headers.get(REQUEST_ID_HEADER)).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('differs between requests', async () => {
    const app = createApp();
    const ids = new Set<string | null>();
    for (let i = 0; i < 5; i += 1) {
      ids.add((await app.request('/v1/health')).headers.get(REQUEST_ID_HEADER));
    }

    expect(ids.size).toBe(5);
  });

  it('ignores an id supplied by the caller', async () => {
    /*
     * A client-supplied `X-Request-Id` is attacker-controlled. Honouring it
     * lets one client stamp every request with the same value, or reuse the id
     * from somebody else's error report — both of which defeat the only thing
     * this field is for.
     */
    const response = await createApp().request('/v1/health', {
      headers: { [REQUEST_ID_HEADER]: 'chosen-by-the-caller' },
    });

    expect(response.headers.get(REQUEST_ID_HEADER)).not.toBe('chosen-by-the-caller');
  });
});

describe('404', () => {
  it('comes back as JSON in the same envelope as every other failure', async () => {
    /*
     * Hono's default is the string `404 Not Found`. A client parsing responses
     * as JSON then gets a syntax error for the most common failure there is,
     * and reports it as "the API returned garbage" rather than "that route
     * does not exist".
     */
    const response = await createApp().request('/v1/nope');

    expect(response.status).toBe(404);
    expect(response.headers.get('content-type')).toContain('application/json');
    expect((await bodyOf(response)).error).toMatchObject({ code: 'not_found' });
  });

  it('carries a request id, like everything else', async () => {
    const response = await createApp().request('/v1/nope');

    expect((await bodyOf(response)).error.requestId).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe('errors thrown inside a mounted surface', () => {
  it('reach the parent handler rather than Hono default output', async () => {
    // Worth asserting rather than assuming: the handler is registered on the
    // composition root, and every real route lives in a sub-app mounted under
    // it. If propagation did not work, every failure in the product would fall
    // back to Hono's plain-text output.
    const surface = new Hono();
    surface.get('/explode', () => {
      throw new ForbiddenError('Not your winery');
    });

    const app = createApp();
    app.route('/v1/dashboard', surface);

    const response = await app.request('/v1/dashboard/explode');

    expect(response.status).toBe(403);
    expect((await bodyOf(response)).error.message).toBe('Not your winery');
  });
});
