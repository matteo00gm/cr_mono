import { randomUUID } from 'node:crypto';
import { isTokenRevoked, resolveTenantByKeyAndOrigin } from '@catalogorosso/db';
import {
  generateWidgetTokenKey,
  InvalidWidgetTokenKeysError,
} from '@catalogorosso/security/tokens';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { buildDependencies } from '../src/composition.js';
import { unconfiguredMembers } from '../src/members.js';
import { ORIGIN_SECRET_HEADER } from '../src/middleware/origin-secret.js';

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
  vi.unstubAllGlobals();
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

  it('sends through Resend in production once a key is supplied', async () => {
    /*
     * The other half of the test above, and the half nothing covered: with a
     * key, on `production`, the reset mail has to reach the provider rather
     * than the log. `send.test.ts` proves `chooseTransport` picks the provider
     * it is given; this proves the composition root gives it one.
     *
     * The key is assembled at runtime, never written out (P0-56).
     */
    const apiKey = ['re', randomUUID()].join('_');
    const fakeFetch = vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(new Response(JSON.stringify({ id: 'resend-message-1' }), { status: 200 })),
    );
    vi.stubGlobal('fetch', fakeFetch);

    const deps = buildDependencies({ ...config, stage: 'production', resendApiKey: apiKey });

    await deps.sendResetPassword({
      to: 'anna@cantina.example',
      url: 'https://app.example/reset/abc',
      token: 'abc',
      userId: 'user_anna',
    });

    expect(fakeFetch).toHaveBeenCalledTimes(1);

    const [url, init] = fakeFetch.mock.calls[0] ?? [];
    expect(url).toBe('https://api.resend.com/emails');
    expect((init?.headers as Record<string, string> | undefined)?.authorization).toBe(
      `Bearer ${apiKey}`,
    );
  });
});

describe('secrets reach the surfaces that check them (A2, P0-64b)', () => {
  /*
   * Each secret is one conditional spread in `buildDependencies`, and removing
   * either failed nothing: `origin-secret.test.ts` and `webhooks.test.ts` hand
   * their secret straight to `createApp`, so both guards were proven to work
   * and neither was proven to be *wired* — E9's shape again. For the origin
   * secret it is worse than E9, because its absent form is permissive: the
   * symptom would be an API quietly answering callers who went around
   * CloudFront.
   *
   * Asserted through requests rather than on the returned fields, because the
   * claim is that the guard runs, not that a property exists.
   */
  it('installs the origin guard when a secret is supplied', async () => {
    const secret = randomUUID();
    const app = createApp(buildDependencies({ ...config, originSecret: secret }));

    const bypassed = await app.request('/v1/dashboard');
    const viaEdge = await app.request('/v1/dashboard', {
      headers: { [ORIGIN_SECRET_HEADER]: secret },
    });

    expect(bypassed.status).toBe(404);
    expect(viaEdge.status).toBe(200);
  });

  it('installs no origin guard without one, which only a local run is allowed', async () => {
    // `index.ts` refuses to start a deployed stage in this shape; the entry
    // point's own test asserts that half.
    const app = createApp(buildDependencies(config));

    expect((await app.request('/v1/dashboard')).status).toBe(200);
  });

  it('hands the webhook surface its signing secret', async () => {
    const unsigned = { method: 'POST', body: JSON.stringify({ type: 'email.bounced' }) };

    const without = createApp(buildDependencies(config));
    const configured = createApp(
      buildDependencies({ ...config, resendWebhookSecret: randomUUID() }),
    );

    // Absent is restrictive: the endpoint does not exist yet.
    expect((await without.request('/v1/webhooks/resend', unsigned)).status).toBe(404);

    // Present, the endpoint exists — and refuses a delivery nobody signed.
    expect((await configured.request('/v1/webhooks/resend', unsigned)).status).toBe(401);
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
            limit: 5,
            key: checks[0]?.key ?? '',
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

describe('the widget surface (P2-10)', () => {
  it('resolves with the real accessor, so every pair is checked against the database', () => {
    expect(buildDependencies(config).widget.resolve).toBe(resolveTenantByKeyAndOrigin);
  });

  it('admits local origins only on a local run', () => {
    expect(buildDependencies({ ...config, stage: 'unknown' }).widget.environment).toBe(
      'development',
    );
    expect(buildDependencies(config).widget.environment).toBe('production');
  });

  it('counts widget requests with the limiter it is given', () => {
    const limiter = { check: () => Promise.reject(new Error('not called here')) };

    expect(buildDependencies({ ...config, rateLimiter: limiter }).widget.limiter).toBe(limiter);
  });

  it('falls back to an in-process limiter on a local run', async () => {
    const { limiter } = buildDependencies(config).widget;

    await expect(
      limiter.check([{ key: `test:${randomUUID()}`, limit: 1, windowSec: 60 }]),
    ).resolves.toMatchObject({ allowed: true });
  });

  it('reads usage through the function it is given', () => {
    const readUsage = () => Promise.resolve(7);

    expect(buildDependencies({ ...config, readUsage }).widget.readUsage).toBe(readUsage);
  });

  it('reads the month from the ledger by default, not from a constant (P2-36)', async () => {
    /*
     * It used to answer nought for every key, which meant §2.3's banner told
     * every seller `ok` however much they had spent. It now asks
     * `usage_events` for the tenant the key names — so a key naming something
     * that is not a tenant id is a bug, and is refused rather than answered.
     */
    await expect(
      buildDependencies(config).widget.readUsage({
        key: 'tenant:not-a-uuid:month',
        limit: 100,
        window: 'month',
      }),
    ).rejects.toThrow(/tenant/i);
  });

  it('answers nought for a key that names no month to read', async () => {
    // The banner is the only caller, and a banner is not worth failing a
    // request over. The gate never takes this path: it builds the key itself.
    await expect(
      buildDependencies(config).widget.readUsage({
        key: 'ip:bucket:unresolved',
        limit: 100,
        window: 'month',
      }),
    ).resolves.toBe(0);
  });

  it("buckets addresses under the deployment's own secret", () => {
    expect(buildDependencies(config).widget.ipSecret).toBe(config.authSecret);
  });
});

describe('the widget session keys (P2-12)', () => {
  it('leaves the session route unconfigured without a keyset', () => {
    expect(buildDependencies(config).widget.tokenKeys).toBeUndefined();
  });

  it('asks the database whether a continuing token was revoked (P2-12a)', () => {
    // Absent, every previous token would be ignored and no conversation could continue.
    expect(buildDependencies(config).widget.isTokenRevoked).toBe(isTokenRevoked);
  });

  it('records a refused widget request rather than only logging it (P2-16)', () => {
    /*
     * Without this the middleware falls back to its own logger, which writes
     * the refusal's type and nothing else — P6-05 has no rows to show a seller,
     * and the abuse threshold has nothing to count. E9's shape again: the guard
     * is proven to work and not proven to be wired.
     */
    expect(buildDependencies(config).widget.onRejected).toBeDefined();
  });

  it('loads the keyset it is given once, however many mints ask at once', async () => {
    const serialized = JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] });
    const { tokenKeys } = buildDependencies({ ...config, widgetTokenKeys: serialized }).widget;
    if (tokenKeys === undefined) throw new Error('expected a key loader');

    const [first, second] = await Promise.all([tokenKeys(), tokenKeys()]);

    expect(first).toBe(second);
    expect(first.signingKid).toBe('k1');
  });

  it('keeps a keyset that will not load failing with its reason, rather than retrying it', async () => {
    const { tokenKeys } = buildDependencies({ ...config, widgetTokenKeys: 'not json' }).widget;
    if (tokenKeys === undefined) throw new Error('expected a key loader');

    await expect(tokenKeys()).rejects.toThrow(InvalidWidgetTokenKeysError);
    await expect(tokenKeys()).rejects.toThrow(/not JSON/);
  });
});
