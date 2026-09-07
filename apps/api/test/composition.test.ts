import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { buildDependencies } from '../src/composition.js';
import { unconfiguredMembers } from '../src/members.js';

/**
 * The composition root (E9).
 *
 * **This file exists because its absence was the bug.** P0-64 and P0-51 were
 * each verified against their own seam — a fake transport, a fake port — and
 * both suites were green while `index.ts` wired neither, so password reset sent
 * nothing and the invite endpoints answered 500 in production.
 *
 * No test in the repository looked at what the *real* entry point assembles,
 * because `index.ts` did its work at module scope and threw on import without
 * `AUTH_SECRET`. Extracting `buildDependencies` is what makes that assertable,
 * and the extraction is most of the fix.
 */

/*
 * `createAuth` builds the drizzle adapter eagerly — `auth.ts` says so, and it is
 * why `apps/api` depends on a two-member `AuthPort` rather than the library's
 * own type. postgres-js connects lazily, so a syntactically valid URL is enough
 * to construct one; nothing here opens a socket.
 */
beforeEach(() => {
  vi.stubEnv('DATABASE_URL', 'postgres://app_rw:pw@localhost:5432/sommelier');
});

afterEach(() => {
  vi.unstubAllEnvs();
});

const config = {
  authSecret: 'a'.repeat(32),
  authBaseUrl: 'https://app.example',
  stage: 'dev',
  emailFrom: 'Sommelier <noreply@sommelier.example>',
  // The default opens a real transaction; production never passes this.
  suppression: () => ({ isSuppressed: () => Promise.resolve(false) }),
};

describe('buildDependencies', () => {
  it('supplies a members port, so the invite endpoints are reachable', () => {
    /*
     * The assertion whose absence caused E9. `createApp` defaults `members` to
     * a port that rejects every call — deliberately, as a wiring-bug detector —
     * and nothing noticed that the detector had become the implementation.
     */
    const deps = buildDependencies(config);

    /*
     * Identity, not shape. `unconfiguredMembers` rejects every call with a
     * wiring error and is the *right* default — but it had quietly become the
     * implementation, and only "is it that one" catches that. A shape check
     * would have passed on the broken version, since the placeholder has the
     * same shape by construction.
     */
    expect(deps.members).not.toBe(unconfiguredMembers);
  });

  it('wires password reset to the email seam rather than a placeholder', async () => {
    const lines: string[] = [];
    const deps = buildDependencies({ ...config, log: (line) => lines.push(line) });

    await deps.sendResetPassword({
      to: 'anna@cantina.example',
      url: 'https://app.example/reset/abc',
      token: 'abc',
      userId: 'user_anna',
    });

    /*
     * In a non-production stage the message goes to the log transport, whole
     * and rendered — which is the point. Before this, a reset in `dev` logged
     * "no email transport is configured" and the link was unrecoverable, so the
     * auth flow could not be exercised locally at all.
     */
    expect(lines[0]).toContain('anna@cantina.example');
    expect(lines[0]).toContain('https://app.example/reset/abc');
  });

  it('does not require an email provider key to start', () => {
    /*
     * A missing key must degrade to the log transport, never fail the
     * container. The sending domain is not authenticated yet (E6), so every
     * stage runs without one today — and a composition root that refused to
     * build would take the whole API down for want of an email address.
     */
    expect(() => buildDependencies({ ...config, resendApiKey: undefined })).not.toThrow();
  });
});

describe('rate limiting (A1)', () => {
  it('wires the limiter into Better Auth when one is supplied', async () => {
    const seen: string[] = [];
    const deps = buildDependencies({
      ...config,
      rateLimiter: {
        check: (checks) => {
          seen.push(...checks.map((c) => c.key));
          return Promise.resolve({
            allowed: false,
            remaining: 0,
            resetAt: new Date(),
            retryAfterSec: 30,
          });
        },
      },
    });

    /*
     * A real request through the real handler, because the option being set and
     * the storage being *consulted* are different claims — and better-auth's
     * options accept unknown keys at that level, so a misspelled
     * `customStorage` typechecks cleanly and falls back to the per-container
     * store. That is A1 reintroduced with nothing failing.
     */
    const response = await deps.auth.handler(
      new Request(`${config.authBaseUrl}/v1/dashboard/auth/sign-in/email`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.7' },
        body: JSON.stringify({ email: 'a@b.example', password: 'whatever' }),
      }),
    );

    expect(seen.length).toBeGreaterThan(0);
    expect(seen[0]).toMatch(/^auth:/);
    expect(response.status).toBe(429);
  });

  it('falls back to the per-container store when none is supplied', () => {
    // Permitted only because `index.ts` refuses to start a deployed stage
    // without one. What it buys is a local run and a suite with no database.
    expect(() => buildDependencies(config)).not.toThrow();
  });
});
