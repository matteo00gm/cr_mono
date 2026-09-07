import process from 'node:process';
import { handle } from 'hono/aws-lambda';

import { createRateLimiter } from '@catalogorosso/db';

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

/**
 * The stage, needed before `buildDependencies` so the guard below can be
 * conditional on being deployed at all.
 */
const stage = optionalEnvironment('SST_STAGE') ?? 'unknown';

/**
 * The origin secret, and the assertion that a deployment has one (A2).
 *
 * **Absent is permissive**, which is the one shape E9 established must never be
 * a silent default: without it the API answers anyone who reaches the Function
 * URL directly, skipping the CloudFront Function that pins the client IP. So a
 * deployed stage refuses to start without it, and only a local run — where
 * `SST_STAGE` is unset and there is no CloudFront in front — is allowed to go
 * without.
 *
 * Failing to start is the right failure. The alternative is a container that
 * comes up healthy and is quietly reachable around the edge, which is precisely
 * the class of bug this whole item came from.
 */
const originSecret = optionalEnvironment('ORIGIN_SECRET');

if (stage !== 'unknown' && originSecret === undefined) {
  throw new Error(
    'ORIGIN_SECRET is not set, but SST_STAGE is — so this is a deployment, and ' +
      'without the secret the API answers requests that bypassed CloudFront and ' +
      'forged their client IP (A2). infra/cdn.ts sets it on the API origin.',
  );
}

/**
 * Where auth rate-limit counters live, and the assertion that a deployment has
 * somewhere durable to put them (A1).
 *
 * **Absent is permissive**, the same shape as the origin secret above: Better
 * Auth falls back to a module-level `Map`, which in Lambda is per container, so
 * N warm containers give an attacker N times each configured limit and a
 * recycle resets the counter to zero. Nothing errors and nothing looks wrong.
 *
 * A local run has no database and is allowed the in-memory behaviour; a
 * deployed stage is not, and refusing to start is the right failure. The
 * alternative is a container that comes up healthy with rate limiting that
 * quietly does not survive its own lifetime.
 */
const rateLimiter = stage === 'unknown' ? undefined : createRateLimiter();

const dependencies = buildDependencies({
  authSecret: requireEnvironment('AUTH_SECRET'),
  authBaseUrl: requireEnvironment('AUTH_BASE_URL'),

  /*
   * Defaults to a name that is *not* `production`, so an unset stage logs mail
   * rather than sending it. The safe direction: a missing variable must never
   * be the reason a real customer receives a message from a staging run.
   */
  stage,
  ...(originSecret === undefined ? {} : { originSecret }),
  ...(rateLimiter === undefined ? {} : { rateLimiter }),

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
