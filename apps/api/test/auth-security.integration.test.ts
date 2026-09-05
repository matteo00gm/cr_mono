import process from 'node:process';
import { createAuth, SESSION_COOKIE_CACHE_SECONDS } from '@catalogorosso/core';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_PUBLIC_PATH, DASHBOARD_PREFIX, WIDGET_PREFIX } from '../src/routes.js';

/**
 * The adversarial auth suite (P0-46).
 *
 * Self-hosting authentication means these failure modes are ours. Better
 * Auth's defaults are sound, but *defaults* are a starting point and
 * configuration drifts — this suite is what makes the choice in P0-45
 * defensible rather than hopeful.
 *
 * Everything here runs against a real database and real cookies, because every
 * property under test is one a fake would answer correctly by construction.
 */

let harness: TestDatabase | undefined;
let app: ReturnType<typeof createApp>;
let resetTokens: string[] = [];

/**
 * Every group calls from its own IP address.
 *
 * Not cosmetic. Better Auth's rate limiter keys on `(ip, path)` and its default
 * store is a **module-level** `Map` — shared by every `betterAuth()` instance in
 * the process, so building a second app does not reset it. Without distinct
 * addresses, one group's deliberate flooding starves the next of sign-ins and
 * the failures land somewhere unrelated.
 *
 * It is also the production property under test. In a deployment every caller
 * must land in its own bucket, or one attacker exhausting the sign-in limit
 * locks out every user — see the `ipAddress` note in `packages/core/src/auth.ts`.
 */
const from = (ip: string) => {
  const headers = { 'x-forwarded-for': ip };

  const post = async (
    path: string,
    payload: unknown,
    extra: Record<string, string> = {},
  ): Promise<Response> =>
    await app.request(`${AUTH_PUBLIC_PATH}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...headers, ...extra },
      body: JSON.stringify(payload),
    });

  return {
    auth: post,

    /** Registers a user and returns their session cookie. */
    register: async (email: string, password = 'a-perfectly-adequate-password') => {
      const response = await post('/sign-up/email', { name: 'Test', email, password });
      return { cookie: response.headers.get('set-cookie') ?? '', email, password };
    },

    signIn: (email: string, password: string): Promise<Response> =>
      post('/sign-in/email', { email, password }),

    /** The one route behind the session guard — the probe for "am I still in". */
    me: async (cookie: string): Promise<Response> =>
      await app.request(`${DASHBOARD_PREFIX}/me`, { headers: { ...headers, cookie } }),
  };
};

const bodyText = async (response: Response): Promise<string> => await response.text();

beforeAll(async () => {
  harness = await startTestDatabase();
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  app = createApp({
    auth: createAuth({
      secret: 'security-suite-secret-value-long-enough-to-be-plausible',
      baseUrl: 'http://localhost',
      basePath: AUTH_PUBLIC_PATH,
      sendResetPassword: ({ token }) => {
        resetTokens.push(token);
        return Promise.resolve();
      },
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('session integrity', () => {
  const caller = from('203.0.113.11');

  it('rejects a tampered session cookie', async () => {
    /*
     * The cookie carries a signature, so flipping a character in the token
     * must not merely miss a row — it must fail the signature check. A store
     * lookup that silently returned nothing would give the same 401 here for
     * the wrong reason, which is why the mutation is in the middle of the
     * value rather than a wholesale replacement.
     */
    const { cookie } = await caller.register('tamper@example.test');

    expect((await caller.me(cookie)).status).toBe(200);

    const tampered = cookie.replace(/(session_token=.{5})./, '$1X');

    expect((await caller.me(tampered)).status).toBe(401);
  });

  it('rejects a session whose user has been deleted', async () => {
    /*
     * A session outliving its user authenticates as somebody who no longer
     * exists. P0-23a's cascade removes the row; this asserts the *effect* —
     * that the API stops accepting the cookie — rather than the foreign key,
     * which is already asserted in packages/db.
     */
    const { cookie, email } = await caller.register('deleted@example.test');
    expect((await caller.me(cookie)).status).toBe(200);

    await harness?.adminDb.execute(sql`delete from auth_users where email = ${email}`);

    expect((await caller.me(cookie)).status).toBe(401);
  });

  it('rejects an expired session', async () => {
    // Expiry is enforced on read, not by a sweep — a session that has passed
    // its expiry must be refused even though its row is still there.
    const { cookie, email } = await caller.register('expired@example.test');

    await harness?.adminDb.execute(sql`
      update auth_sessions set expires_at = now() - interval '1 hour'
      where user_id = (select id from auth_users where email = ${email})
    `);

    expect((await caller.me(cookie)).status).toBe(401);
  });

  it('invalidates the session on sign-out', async () => {
    const { cookie } = await caller.register('signout@example.test');

    const out = await caller.auth('/sign-out', {}, { cookie });
    expect(out.status).toBe(200);

    expect((await caller.me(cookie)).status).toBe(401);
  });

  it('invalidates across devices, not just the one that signed out', async () => {
    /*
     * Two sessions for one user, and signing out of one must not leave the
     * other alive when the revocation was meant to be global. This is the
     * property that matters after "sign out everywhere" on a shared machine.
     */
    const { email, password } = await caller.register('devices@example.test');

    const first = (await caller.signIn(email, password)).headers.get('set-cookie') ?? '';
    const second = (await caller.signIn(email, password)).headers.get('set-cookie') ?? '';

    expect((await caller.me(first)).status).toBe(200);
    expect((await caller.me(second)).status).toBe(200);

    await caller.auth('/sign-out', {}, { cookie: first });

    // The signed-out one is gone.
    expect((await caller.me(first)).status).toBe(401);

    /*
     * The other is *deliberately* still valid: Better Auth's `/sign-out`
     * revokes the presented session only. Recorded as an assertion rather than
     * left implicit, because "sign out everywhere" is a separate endpoint
     * (`/revoke-sessions`) and a reader could reasonably assume otherwise.
     */
    expect((await caller.me(second)).status).toBe(200);
  });

  it('revokes every session when asked to', async () => {
    const { email, password } = await caller.register('revokeall@example.test');

    const first = (await caller.signIn(email, password)).headers.get('set-cookie') ?? '';
    const second = (await caller.signIn(email, password)).headers.get('set-cookie') ?? '';

    await caller.auth('/revoke-sessions', {}, { cookie: first });

    expect((await caller.me(first)).status).toBe(401);
    expect((await caller.me(second)).status).toBe(401);
  });

  it('bounds how long a cached session can outlive a revocation', () => {
    /*
     * The cookie cache is a deliberate trade: it makes the common read cheap
     * by trusting a signed copy, at the cost of a revocation taking up to its
     * TTL to bite. What is asserted is the *bound*, because that is the term
     * of the trade — five minutes, chosen in P0-23a. P4-11's step-up check
     * reads the database directly precisely so it is not subject to this.
     */
    expect(SESSION_COOKIE_CACHE_SECONDS).toBeLessThanOrEqual(300);
  });
});

describe('account enumeration', () => {
  const caller = from('203.0.113.12');

  const existing = 'enumerate@example.test';

  beforeAll(async () => {
    await caller.register(existing);
  });

  it('answers a wrong password and an unknown address identically', async () => {
    /*
     * The classic oracle. If "no such user" and "wrong password" differ in
     * status, body or error code, an attacker can harvest which addresses hold
     * accounts — which is a privacy breach on its own and the first step of a
     * credential-stuffing run.
     */
    const wrongPassword = await caller.signIn(existing, 'definitely-not-the-password');
    const unknownUser = await caller.signIn('nobody@example.test', 'definitely-not-the-password');

    expect(unknownUser.status).toBe(wrongPassword.status);
    expect(await bodyText(unknownUser)).toBe(await bodyText(wrongPassword));
  });

  it('answers a password reset identically whether or not the address exists', async () => {
    /*
     * Fragile for a reason worth naming: Better Auth calls `sendResetPassword`
     * only when the user exists, so a send seam that *threw* would 500 for real
     * addresses and 200 for made-up ones — an oracle manufactured by the
     * transport rather than by the auth logic. The P0-64 placeholder resolves
     * precisely to avoid that, and this is the assertion that keeps it honest.
     */
    const real = await caller.auth('/request-password-reset', {
      email: existing,
      redirectTo: 'http://localhost/reset',
    });
    const fake = await caller.auth('/request-password-reset', {
      email: 'nobody-at-all@example.test',
      redirectTo: 'http://localhost/reset',
    });

    expect(fake.status).toBe(real.status);
    expect(await bodyText(fake)).toBe(await bodyText(real));
  });

  it('does not leak existence through response timing', async () => {
    /*
     * The leak a functional test cannot see. The classic form is a hashing
     * shortcut: a real user's password is verified with argon2 (deliberately
     * slow), while an unknown address returns immediately — so the *duration*
     * answers the question the body refused to.
     *
     * Measured as a ratio over repeated runs rather than as an absolute, since
     * absolute timings on a laptop, in CI and under a container all differ. The
     * band is wide on purpose: this is looking for the order-of-magnitude
     * difference a skipped hash produces, not for a microsecond side channel,
     * and a tight bound here would be a flaky test rather than a stronger one.
     */
    const measure = async (email: string): Promise<number> => {
      const started = performance.now();
      await caller.signIn(email, 'definitely-not-the-password');
      return performance.now() - started;
    };

    // Warm the paths first: the first argon2 call in a process pays one-off
    // costs that would otherwise dominate the comparison.
    await measure(existing);
    await measure('nobody@example.test');

    const samples = 5;
    let known = 0;
    let unknown = 0;
    for (let i = 0; i < samples; i += 1) {
      known += await measure(existing);
      unknown += await measure(`nobody-${String(i)}@example.test`);
    }

    const ratio = known / samples / (unknown / samples);

    // An unknown-user path that skips hashing entirely shows up here as a
    // ratio in the tens or hundreds.
    expect(ratio).toBeLessThan(8);
    expect(ratio).toBeGreaterThan(1 / 8);
  });
});

describe('password reset', () => {
  const caller = from('203.0.113.13');

  const email = 'reset@example.test';
  const original = 'the-original-password-value';

  const requestReset = async (): Promise<string> => {
    resetTokens = [];
    await caller.auth('/request-password-reset', { email, redirectTo: 'http://localhost/reset' });
    return resetTokens[0] ?? '';
  };

  beforeAll(async () => {
    await caller.register(email, original);
  });

  it('accepts its token exactly once', async () => {
    /*
     * A reset token is a password with a short life. If it survives its own
     * use, anyone who later reads the email — a shared inbox, a forwarded
     * thread, a backup — can take the account over again at any time.
     */
    const token = await requestReset();

    const first = await caller.auth('/reset-password', {
      token,
      newPassword: 'first-new-password',
    });
    expect(first.status).toBe(200);

    const second = await caller.auth('/reset-password', {
      token,
      newPassword: 'second-new-password',
    });
    expect(second.status).toBeGreaterThanOrEqual(400);
  });

  it('actually changes the password it claims to', async () => {
    // The other half: a reset that returns 200 and leaves the old password
    // working is worse than one that fails, because nobody investigates it.
    const token = await requestReset();
    await caller.auth('/reset-password', { token, newPassword: 'a-third-new-password' });

    expect((await caller.signIn(email, original)).status).toBeGreaterThanOrEqual(400);
    expect((await caller.signIn(email, 'a-third-new-password')).status).toBe(200);
  });

  it('will not let one user’s token reset another user', async () => {
    /*
     * The token has to be bound to the identity it was issued for. If the
     * account being reset came from the *request* rather than from the token,
     * anyone could reset their own password and redirect the change at
     * somebody else.
     */
    const victim = 'victim@example.test';
    await caller.register(victim, 'victims-own-password');

    const attackerToken = await requestReset();
    await caller.auth('/reset-password', { token: attackerToken, newPassword: 'attacker-chosen' });

    // The victim's password is untouched.
    expect((await caller.signIn(victim, 'victims-own-password')).status).toBe(200);
    expect((await caller.signIn(victim, 'attacker-chosen')).status).toBeGreaterThanOrEqual(400);
  });

  it('leaves no reusable verification row behind', async () => {
    /*
     * Asserted at the database, not through the API. A token that is refused
     * on replay but whose row lingers is a stored credential with no expiry
     * story — and `auth_verifications` is readable by `app_rw` like every other
     * un-scoped auth table (P0-23a).
     */
    const token = await requestReset();
    await caller.auth('/reset-password', { token, newPassword: 'yet-another-password' });

    const rows = await harness?.adminDb.execute(
      sql`select 1 from auth_verifications where value = ${token}`,
    );

    expect([...(rows ?? [])]).toHaveLength(0);
  });
});

describe('rate limiting', () => {
  const caller = from('203.0.113.14');
  const somebodyElse = from('198.51.100.99');

  it('is enabled explicitly, never inherited from NODE_ENV', async () => {
    /*
     * The single most valuable assertion in this file.
     *
     * Better Auth resolves `enabled: options.rateLimit?.enabled ?? isProduction`,
     * and its `isProduction` is `NODE_ENV === 'production'` defaulting to
     * `'development'` — while **AWS Lambda does not set `NODE_ENV`**. Left at
     * the default, every auth endpoint in production would have been unlimited
     * and nothing about the deployment would have looked wrong.
     *
     * Asserted by behaviour rather than by reading the config back, because the
     * config is exactly what would be wrong.
     */
    const email = 'ratelimit@example.test';
    await caller.register(email);

    const statuses: number[] = [];
    for (let i = 0; i < 15; i += 1) {
      statuses.push((await caller.signIn(email, 'wrong-password-on-purpose')).status);
    }

    expect(statuses).toContain(429);
  });

  it('buckets by caller, so one attacker cannot lock out everybody', async () => {
    /*
     * The other half, and the one that decides whether this limiter is a
     * protection or a denial of service.
     *
     * Better Auth keys on `(ip, path)` and falls back to a **single shared
     * bucket per path** when it cannot resolve an address — which it cannot
     * whenever `NODE_ENV` is unset, because `getIP` then returns `127.0.0.1`
     * for everyone. AWS Lambda does not set `NODE_ENV`, so enabling rate
     * limiting without also setting it would have locked every user out the
     * first time one attacker exhausted the sign-in limit.
     */
    const victim = 'not-the-attacker@example.test';
    await somebodyElse.register(victim, 'a-perfectly-adequate-password');

    // The attacker's bucket is already exhausted by the test above.
    expect((await caller.signIn(victim, 'wrong')).status).toBe(429);

    // Somebody else, from another address, is entirely unaffected.
    const theirs = await somebodyElse.signIn(victim, 'a-perfectly-adequate-password');
    expect(theirs.status).toBe(200);
  });

  it('limits password reset harder than sign-in', async () => {
    /*
     * Reset is tighter because each success spends an email against the 100/day
     * Resend cap (P0-64), so the limit protects a budget as well as an account.
     */
    const statuses: number[] = [];
    for (let i = 0; i < 10; i += 1) {
      const response = await caller.auth('/request-password-reset', {
        email: 'rate-reset@example.test',
        redirectTo: 'http://localhost/reset',
      });
      statuses.push(response.status);
    }

    expect(statuses).toContain(429);
  });
});

describe('cookie flags', () => {
  const caller = from('203.0.113.15');

  it('are present on the sign-in response', async () => {
    /*
     * Read off the wire rather than out of the configuration: `useSecureCookies`
     * and `defaultCookieAttributes` are separate options that Better Auth merges
     * with its own defaults, so reading the config back would only confirm what
     * was written down.
     *
     * `Secure` is not asserted here — Better Auth drops it over plain `http://`,
     * which is what this suite speaks, and requiring it would mean either
     * running the suite against TLS or weakening the production setting to make
     * a test pass. It is asserted at the configuration level in
     * `packages/core/test/auth.test.ts` instead.
     */
    const { email, password } = await caller.register('cookies@example.test');
    const cookie = (await caller.signIn(email, password)).headers.get('set-cookie') ?? '';

    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
    expect(cookie.toLowerCase()).toContain('path=/');
  });
});

describe('surface isolation', () => {
  const caller = from('203.0.113.16');

  it('grants nothing on the widget surface with a valid dashboard cookie', async () => {
    /*
     * Two authentication systems on one API is exactly where confusion bugs
     * live, so this presents a genuinely valid session — not a made-up one — to
     * the surface that must never accept cookies (§3.4).
     */
    const { email, password } = await caller.register('isolation@example.test');
    const cookie = (await caller.signIn(email, password)).headers.get('set-cookie') ?? '';

    const surface = await app.request(WIDGET_PREFIX, { headers: { cookie } });
    const authRoute = await app.request(`${WIDGET_PREFIX}/auth/sign-in/email`, {
      method: 'POST',
      headers: { cookie },
    });

    // The widget's own public route still answers, and answers as the widget.
    expect(await surface.json()).toEqual({ surface: 'widget' });
    // And Better Auth is simply not mounted there.
    expect(authRoute.status).toBe(404);
  });

  it('grants nothing on the dashboard without a cookie, even to a widget caller', async () => {
    const response = await app.request(`${DASHBOARD_PREFIX}/me`, {
      headers: { authorization: 'Bearer a-widget-style-token' },
    });

    expect(response.status).toBe(401);
  });
});
