import { ApiError } from '@catalogorosso/api-client';

/**
 * What a seller is told when a request itself failed.
 *
 * **This screen's own copy, not the server's message.** A `DomainError`'s text
 * is Italian too (P6-12), and the screens that have nothing better to say print
 * it; here the screen knows what the seller was doing — saving a wine, starting
 * a reindex — and says that, which the API's sentence cannot. The request id is
 * what makes a support conversation possible, so it
 * is quoted whenever the server gave one — and only then: `'unknown'` is the
 * client's placeholder for a body that carried none, and "codice unknown" is a
 * support ticket that goes nowhere.
 */
export const describeFailure = (base: string, error: unknown): string =>
  error instanceof ApiError && error.requestId !== 'unknown'
    ? `${base} Se il problema continua, indica il codice ${error.requestId}.`
    : base;
