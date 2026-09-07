import process from 'node:process';
import { handle } from 'hono/aws-lambda';

import { createApp } from './app.js';
import { buildDependencies } from './composition.js';
import { logger } from './middleware/logger.js';

/**
 * The Lambda entry point (P0-45).
 *
 * Kept apart from `app.ts` so the app itself is reachable without the AWS shim:
 * every test in this package builds a `Hono` instance and calls
 * `app.request(...)`, which needs no event envelope, no context object and no
 * AWS at all.
 *
 * **The assembly moved to `composition.ts` (E9), and the move is the fix.**
 * This file used to construct the dependencies here, at module scope, and throw
 * on import without `AUTH_SECRET` — so nothing could assert what it built, and
 * nothing did. Both P0-64's email seam and P0-51's members port were finished,
 * tested against their own fakes, and wired to nothing: password reset sent
 * nothing and the invite endpoints answered 500. What is left here is reading
 * the environment, which is the part that legitimately cannot be tested without
 * one.
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
 * Optional, and each absence has a defined behaviour rather than a failure.
 *
 * The sending domain is not authenticated yet (E6), so every stage runs without
 * `RESEND_API_KEY` today — and a composition root that refused to build for want
 * of an email key would take the whole API down. Absent means the log transport,
 * which is also what `chooseTransport` picks for any non-production stage.
 */
const optionalEnvironment = (name: string): string | undefined => {
  const value = process.env[name]?.trim();
  return value === undefined || value === '' ? undefined : value;
};

const dependencies = buildDependencies({
  authSecret: requireEnvironment('AUTH_SECRET'),
  authBaseUrl: requireEnvironment('AUTH_BASE_URL'),

  /*
   * Defaults to a name that is *not* `production`, so an unset stage logs mail
   * rather than sending it. The safe direction: a missing variable must never
   * be the reason a real customer receives a message from a staging run.
   */
  stage: optionalEnvironment('SST_STAGE') ?? 'unknown',

  emailFrom: optionalEnvironment('EMAIL_FROM') ?? 'AI Sommelier <noreply@localhost>',
  resendApiKey: optionalEnvironment('RESEND_API_KEY'),

  /** Comma-separated. The addresses a non-production stage may really mail. */
  emailAllowlist: optionalEnvironment('EMAIL_ALLOWLIST')
    ?.split(',')
    .map((address) => address.trim()),

  onEmailFailure: (failure) => {
    /*
     * The alarm P0-64 asks for. Logged rather than thrown, because the caller
     * that most needs this — password reset — must answer identically whether
     * or not the message went out, or the difference becomes an account
     * enumeration oracle. The address is not logged: it would be scrubbed by
     * the P0-56 redaction anyway, and a log line that depends on an allowlist
     * rule to avoid recording PII is one bad edit from recording it.
     */
    void failure;
    logger.error({ kind: 'email_send_failed' }, 'a message was abandoned after retries (P0-64)');
  },
});

/** Built once per container, so route registration is not per-invocation work. */
export const handler = handle(createApp(dependencies));

export { createApp } from './app.js';
