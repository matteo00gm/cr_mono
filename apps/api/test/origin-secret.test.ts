import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { ORIGIN_SECRET_HEADER, requireOriginSecret } from '../src/middleware/origin-secret.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The origin guard (A2).
 *
 * **What it defends against, precisely.** The Lambda Function URL is publicly
 * invokable, and a request that reaches it directly never passes the CloudFront
 * Function that overwrites `X-Forwarded-For` — so the origin believes whatever
 * client IP that caller claims. Measured on a deployed stage before this
 * existed: a forged header sent to the Function URL was believed, while the
 * same forgery through the distribution was overwritten.
 *
 * The consequence is not "slightly weaker limiting". Per-caller rate limits
 * become per-*claimed*-caller, so rotating a header buys unlimited sign-in
 * attempts, and `audit_log.ip` records an attacker-chosen value — worse than
 * recording none, because it is a record people believe.
 */

const SECRET = 'x'.repeat(64);

/*
 * The real app rather than a bare `Hono` with the middleware bolted on. The
 * first version of this file did the latter and every refusal came back 500,
 * because a thrown `DomainError` only becomes a response through the handler
 * `createApp` registers — so the standalone version was asserting the guard in
 * a shape that does not exist. Using the real app also pins the registration
 * order, which is half of what makes this work.
 */
const withGuard = () => createApp({ ...options, originSecret: SECRET });

const options = { auth: signedIn(), readMemberships: oneMembership() };

describe('requireOriginSecret', () => {
  it('lets a request carrying the secret through', async () => {
    const response = await withGuard().request('/v1/health', {
      headers: { [ORIGIN_SECRET_HEADER]: SECRET },
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toContain('"status":"ok"');
  });

  it('refuses a request with no header', async () => {
    // The shape of every request that skipped CloudFront.
    expect((await withGuard().request('/v1/health')).status).toBe(404);
  });

  it('refuses a wrong secret of the same length', async () => {
    const response = await withGuard().request('/v1/health', {
      headers: { [ORIGIN_SECRET_HEADER]: 'y'.repeat(64) },
    });

    expect(response.status).toBe(404);
  });

  it('refuses a prefix of the secret', async () => {
    /*
     * The length check exists because `timingSafeEqual` throws on a mismatch
     * rather than returning false — so without it a short header would be a 500
     * carrying a stack trace, which is both an error and an oracle.
     */
    const response = await withGuard().request('/v1/health', {
      headers: { [ORIGIN_SECRET_HEADER]: 'x'.repeat(32) },
    });

    expect(response.status).toBe(404);
  });

  it('answers 404 rather than 403', async () => {
    /*
     * §3.5's reasoning applied to a host rather than a row: 403 confirms
     * something is there and that only the header is missing, which tells a
     * prober they have found the origin and should go looking for the secret.
     * 404 says nothing.
     */
    const response = await withGuard().request('/v1/dashboard/me');
    const body = (await response.json()) as { error?: { code?: string } };

    expect(response.status).toBe(404);
    expect(body.error?.code).not.toBe('forbidden');
  });

  it('refuses to be constructed with an empty secret', () => {
    /*
     * The E9 shape, refused at construction. An empty expected value would make
     * every request fail to match — or, written the other way round, make every
     * request pass — and a guard that silently becomes a no-op is the failure
     * this repository has already paid for once.
     */
    expect(() => requireOriginSecret('')).toThrow(/empty/);
    expect(() => requireOriginSecret('   ')).toThrow(/empty/);
  });
});

describe('createApp', () => {
  it('installs the guard when a secret is supplied', async () => {
    const app = createApp({ ...options, originSecret: SECRET });

    // Even the health endpoint, which is otherwise public: a caller reaching
    // the origin directly should learn nothing at all, including whether it is
    // up.
    expect((await app.request('/v1/health')).status).toBe(404);
    expect(
      (await app.request('/v1/health', { headers: { [ORIGIN_SECRET_HEADER]: SECRET } })).status,
    ).toBe(200);
  });

  it('runs without the guard when no secret is supplied', async () => {
    /*
     * Permitted, and *only* because `src/index.ts` refuses to start a deployed
     * stage without one — absent is permissive here, so the check has to live
     * somewhere that knows whether CloudFront is in front. What this buys is a
     * suite that does not manufacture a header on every call.
     */
    expect((await createApp(options).request('/v1/health')).status).toBe(200);
  });

  it('refuses before reading a body', async () => {
    const app = createApp({ ...options, originSecret: SECRET });

    // Registered above every route and every parse, so a direct caller cannot
    // even make the origin do work — which is the point of refusing at the edge
    // of the application rather than inside a handler.
    const response = await app.request('/v1/dashboard/auth/sign-in/email', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: '{"email":"a@b.example","password":"whatever"}',
    });

    expect(response.status).toBe(404);
  });
});
