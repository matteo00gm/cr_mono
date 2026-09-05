import process from 'node:process';
import { createAuth } from '@catalogorosso/core';
import { readMembershipsForUser } from '@catalogorosso/db';
import { handle } from 'hono/aws-lambda';

import { createApp } from './app.js';

import { logger } from './middleware/logger.js';
import { AUTH_PUBLIC_PATH } from './routes.js';

/**
 * The Lambda entry point, and the composition root (P0-45).
 *
 * Kept apart from `app.ts` so the app itself is reachable without the AWS shim:
 * every test in this package builds a `Hono` instance and calls
 * `app.request(...)`, which needs no event envelope, no context object and no
 * AWS at all. This file is where the real dependencies — configuration, the
 * database, Better Auth — are assembled, and it is the only file that does.
 *
 * `handle`, not `streamHandle`: this function is BUFFERED (§5.1). The streaming
 * chat endpoint gets its own `RESPONSE_STREAM` Function URL in P2-29, because
 * the two modes are a property of the *function*, not of the route.
 */

const requireEnvironment = (name: string): string => {
  const value = process.env[name];
  if (value === undefined || value.trim() === '') {
    throw new Error(
      `${name} is not set. It is mirrored to SSM as /sommelier/<stage>/${name.toLowerCase().replace('_', '/')} (P0-15).`,
    );
  }
  return value;
};

/**
 * The P0-64 seam, standing in until Resend is wired.
 *
 * **It resolves rather than throwing, and that is a security decision, not
 * laziness.** Better Auth calls `sendResetPassword` only when the address
 * actually belongs to a user. A placeholder that threw would therefore make
 * password reset 500 for real addresses and 200 for made-up ones — an account
 * enumeration oracle manufactured by the stub itself, and precisely what
 * P0-46's enumeration group exists to prevent. Resolving keeps the two
 * responses identical.
 *
 * The address is deliberately not logged. It would be scrubbed by the P0-56
 * redaction anyway, but a log line that depends on a redaction rule to avoid
 * recording PII is one bad allowlist edit from recording it.
 */
const sendResetPassword = (): Promise<void> => {
  logger.error(
    { kind: 'email_transport_missing' },
    'password reset requested but no email transport is configured — see P0-64',
  );
  return Promise.resolve();
};

export const auth = createAuth({
  secret: requireEnvironment('AUTH_SECRET'),
  baseUrl: requireEnvironment('AUTH_BASE_URL'),

  /*
   * The *mounted* path, not `/auth`. Better Auth is handed the raw `Request`,
   * whose URL carries the whole path, and it builds reset and callback URLs
   * from `baseUrl + basePath` — so the sub-app-relative prefix would both
   * fail to match and email people links that go nowhere.
   */
  basePath: AUTH_PUBLIC_PATH,

  sendResetPassword,
});

/** Built once per container, so route registration is not per-invocation work. */
export const handler = handle(createApp({ auth, readMemberships: readMembershipsForUser }));

export { createApp } from './app.js';
