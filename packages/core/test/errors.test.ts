import { describe, expect, it } from 'vitest';

import {
  ConflictError,
  DOMAIN_ERROR_KINDS,
  DomainError,
  ForbiddenError,
  InvalidRequestError,
  isDomainError,
  NotFoundError,
  RateLimitedError,
  UnauthenticatedError,
  type DomainErrorKind,
} from '../src/errors.js';

/**
 * Domain errors (P0-55).
 *
 * These carry no HTTP status codes, so there is nothing here about 404s. What
 * is worth asserting is the classification itself — because
 * `apps/api/src/middleware/error.ts` returns a domain error's message to the
 * caller and withholds everything else's, and a misclassification is therefore
 * either a disclosure or a swallowed message.
 */

describe('the subclasses', () => {
  const cases: readonly [new (message?: string) => DomainError, DomainErrorKind][] = [
    [NotFoundError, 'not_found'],
    [UnauthenticatedError, 'unauthenticated'],
    [ForbiddenError, 'forbidden'],
    [InvalidRequestError, 'invalid'],
    [ConflictError, 'conflict'],
    [RateLimitedError, 'rate_limited'],
  ];

  it.each(cases)('%s carries its kind', (Ctor, kind) => {
    expect(new Ctor().kind).toBe(kind);
  });

  it.each(cases)('%s reports its own name, not "Error"', (Ctor) => {
    // `extends Error` alone leaves `name` as "Error" on every subclass, which
    // makes a log line say nothing about what actually happened.
    expect(new Ctor().name).toBe(Ctor.name);
  });

  it.each(cases)('%s has a usable default message', (Ctor) => {
    expect(new Ctor().message.length).toBeGreaterThan(0);
  });

  it('covers every declared kind', () => {
    // A kind without a class is one nobody can throw; the compiler does not
    // catch that, because the list and the classes are independent.
    expect(cases.map(([, kind]) => kind).sort()).toEqual([...DOMAIN_ERROR_KINDS].sort());
  });

  it('keeps a caller message and a cause', () => {
    const cause = new Error('duplicate key value violates unique constraint');
    const error = new ConflictError('That SKU already exists', { cause });

    expect(error.message).toBe('That SKU already exists');
    expect(error.cause).toBe(cause);
  });
});

describe('isDomainError', () => {
  it('accepts every subclass', () => {
    expect(isDomainError(new NotFoundError())).toBe(true);
    expect(isDomainError(new DomainError('invalid', 'x'))).toBe(true);
  });

  it('rejects an ordinary Error', () => {
    // The asymmetry the error handler depends on: this one's message must not
    // reach the caller.
    expect(isDomainError(new Error('postgres://user:pw@host/db'))).toBe(false);
  });

  it('rejects non-Error values', () => {
    for (const value of [undefined, null, 'not_found', 42, { kind: 'not_found' }]) {
      expect(isDomainError(value)).toBe(false);
    }
  });

  it('rejects an Error carrying an unrecognised kind', () => {
    /*
     * Matters because the structural check below is deliberately loose. An
     * error that invented its own `kind` must not be classified as a domain
     * error — the handler would then look its kind up in a table that has no
     * entry, and return `undefined` as a status.
     */
    const impostor = Object.assign(new Error('leak me'), { kind: 'teapot' });

    expect(isDomainError(impostor)).toBe(false);
  });

  it('accepts a domain error from a second copy of this module', () => {
    /*
     * The reason the check is structural and not just `instanceof`.
     *
     * A Lambda bundle can end up with two copies of this module — a workspace
     * link beside a bundled one, or two versions mid-deploy — and then
     * `instanceof` is false for an object that is a `DomainError` in every way
     * that matters. The consequence is not cosmetic: a genuine 404 would be
     * reported as an unexpected 500 and the caller's message swallowed.
     */
    const fromElsewhere = Object.assign(new Error('No such wine'), { kind: 'not_found' });

    expect(fromElsewhere).not.toBeInstanceOf(DomainError);
    expect(isDomainError(fromElsewhere)).toBe(true);
  });
});
