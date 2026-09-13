import { ApiError } from '@catalogorosso/api-client';

/**
 * What a seller is told when a request itself failed.
 *
 * **Italian copy, never the server's message.** A `DomainError`'s text is the
 * API contract (P0-55) and it is written in English; this console has one
 * language. The request id is what makes a support conversation possible, so it
 * is quoted whenever the server gave one — and only then: `'unknown'` is the
 * client's placeholder for a body that carried none, and "codice unknown" is a
 * support ticket that goes nowhere.
 */
export const describeFailure = (base: string, error: unknown): string =>
  error instanceof ApiError && error.requestId !== 'unknown'
    ? `${base} Se il problema continua, indica il codice ${error.requestId}.`
    : base;
