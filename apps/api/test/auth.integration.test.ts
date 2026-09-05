import process from 'node:process';
import { createAuth } from '@catalogorosso/core';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_PUBLIC_PATH, DASHBOARD_PREFIX, WIDGET_PREFIX } from '../src/routes.js';

/**
 * The real Better Auth against real Postgres (P0-45).
 *
 * **This suite exists because a fake cannot verify any of it.** The unit tests
 * hand `requireUser` a stub `getSession`, which proves the guard is mounted in
 * the right place and proves nothing about whether the library can reach the
 * `auth_*` tables at all. The first draft of this task configured `basePath` as
 * `/auth` rather than `/v1/dashboard/auth`, which would have 404'd every auth
 * endpoint in production — and the whole unit suite stayed green.
 *
 * What is being verified here is the seam between three things that were each
 * decided separately and have never met: P0-23a's table names, the drizzle
 * adapter's model-name resolution, and the mount path.
 */

let harness: TestDatabase | undefined;
let app: ReturnType<typeof createApp>;
const resetEmails: { to: string; url: string }[] = [];

const post = async (path: string, payload: unknown): Promise<Response> =>
  // `app.request` is typed as `Response | Promise<Response>`; awaiting
  // normalises it without the caller having to care which it returned.
  await app.request(path, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload),
  });

const credentials = {
  name: 'Matteo',
  email: 'matteo@cantina-colpetrone.example',
  password: 'a-long-enough-password-for-better-auth',
};

beforeAll(async () => {
  harness = await startTestDatabase();

  /*
   * The adapter reads `DATABASE_URL` through the same memoised client the
   * application uses (`packages/db/src/auth-db.ts`), so the container's URL has
   * to be in the environment before `createAuth` runs. Set rather than stubbed
   * because the client memoises on first use for the life of the process.
   */
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  app = createApp({
    auth: createAuth({
      secret: 'integration-suite-secret-value-not-used-anywhere-real',
      baseUrl: 'http://localhost',
      basePath: AUTH_PUBLIC_PATH,
      sendResetPassword: ({ to, url }) => {
        resetEmails.push({ to, url });
        return Promise.resolve();
      },
    }),
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
});

describe('sign-up', () => {
  it('creates a user Better Auth can find again', async () => {
    /*
     * The assertion that proves the whole adapter mapping. Better Auth's model
     * is `user`; our table is `auth_users`, because `user` is a reserved word
     * in Postgres (P0-23a). The drizzle adapter resolves `schema[model]` by the
     * *configured* model name, so a mismatch between the `modelName` strings in
     * `packages/core/src/auth.ts` and the keys in `authSchema` throws here —
     * and only here, at the first query, never at startup.
     */
    const response = await post(`${AUTH_PUBLIC_PATH}/sign-up/email`, credentials);

    expect(response.status).toBe(200);

    const rows = await harness?.adminDb.execute(
      sql`select email from auth_users where email = ${credentials.email}`,
    );
    expect([...(rows ?? [])]).toHaveLength(1);
  });

  it('stores the password on auth_accounts and never on auth_users', async () => {
    // One row per provider per user, and the credential provider is one of
    // them. A hash on the user row would have to be null for every OAuth user.
    const accounts = await harness?.adminDb.execute(
      sql`select provider_id, password from auth_accounts`,
    );
    const rows = [...(accounts ?? [])] as { provider_id: string; password: string }[];

    expect(rows[0]?.provider_id).toBe('credential');
    expect(rows[0]?.password).not.toContain(credentials.password);
  });
});

describe('sign-in', () => {
  let cookie: string;

  it('issues a session cookie', async () => {
    const response = await post(`${AUTH_PUBLIC_PATH}/sign-in/email`, {
      email: credentials.email,
      password: credentials.password,
    });

    expect(response.status).toBe(200);

    cookie = response.headers.get('set-cookie') ?? '';
    expect(cookie).not.toBe('');
  });

  it('sets HttpOnly and SameSite=Lax on that cookie', () => {
    /*
     * Asserted on the wire rather than on the configuration. `useSecureCookies`
     * and `defaultCookieAttributes` are two separate options and the library
     * merges them with its own defaults; reading the config back would only
     * confirm what was written down.
     *
     * `Secure` is deliberately not asserted: Better Auth drops it over plain
     * `http://`, which is what this suite speaks, and requiring it here would
     * mean either testing against TLS or weakening the production setting to
     * make a test pass.
     */
    expect(cookie.toLowerCase()).toContain('httponly');
    expect(cookie.toLowerCase()).toContain('samesite=lax');
  });

  it('is rejected with the wrong password', async () => {
    const response = await post(`${AUTH_PUBLIC_PATH}/sign-in/email`, {
      email: credentials.email,
      password: 'not-the-password',
    });

    expect(response.status).toBeGreaterThanOrEqual(400);
  });

  it('lets the session through requireUser, which is the point of all of it', async () => {
    // End to end: a real cookie, read by the real library, through our guard,
    // to a route that reports the user it attached.
    const response = await app.request(`${DASHBOARD_PREFIX}/me`, { headers: { cookie } });
    const payload = (await response.json()) as { userId?: unknown };

    expect(response.status).toBe(200);
    expect(typeof payload.userId).toBe('string');
  });

  it('does not grant anything on the widget surface', async () => {
    /*
     * Surface isolation, in the direction that matters most. The widget
     * authenticates with origin-bound tokens and must never accept a cookie
     * (§3.4) — this presents a genuinely valid dashboard session to it and
     * asserts the auth endpoints are simply not there.
     */
    const response = await app.request(`${WIDGET_PREFIX}/auth/sign-in/email`, {
      method: 'POST',
      headers: { cookie },
    });

    expect(response.status).toBe(404);
  });
});

describe('password reset', () => {
  it('calls the send seam with a link built from baseUrl and basePath', async () => {
    /*
     * The failure this catches is silent and expensive: a `basePath` that is
     * route-correct but not mount-correct still produces a *link*, and that
     * link 404s when the recipient clicks it. Nothing in the API's own
     * behaviour would look wrong.
     */
    resetEmails.length = 0;

    const response = await post(`${AUTH_PUBLIC_PATH}/request-password-reset`, {
      email: credentials.email,
      redirectTo: 'http://localhost/reset',
    });

    expect(response.status).toBe(200);
    expect(resetEmails).toHaveLength(1);
    expect(resetEmails[0]?.to).toBe(credentials.email);
    expect(resetEmails[0]?.url).toContain(AUTH_PUBLIC_PATH);
  });

  it('answers identically for an address that does not exist', async () => {
    /*
     * Account enumeration, checked here rather than only in P0-46 because the
     * P0-64 placeholder in `index.ts` is what makes it fragile: a stub that
     * *threw* would 500 for real addresses and 200 for made-up ones, because
     * Better Auth only calls the seam when the user exists. The oracle would be
     * manufactured by the placeholder itself.
     */
    resetEmails.length = 0;

    const response = await post(`${AUTH_PUBLIC_PATH}/request-password-reset`, {
      email: 'nobody@nowhere.example',
      redirectTo: 'http://localhost/reset',
    });

    expect(response.status).toBe(200);
    expect(resetEmails).toHaveLength(0);
  });
});

describe('the twoFactor plugin columns', () => {
  it('are present, which is why P0-45 needed a migration', async () => {
    /*
     * Better Auth 1.7.2's twoFactor plugin merges `twoFactorEnabled` into the
     * *user* model and requires `verified`, `failedVerificationCount` and
     * `lockedUntil` on its own. P0-23a created the table before the plugin was
     * wired, so none of them existed. Mounting the plugin without them fails at
     * the first enrolment — a runtime failure in the middle of MFA setup rather
     * than a startup one.
     */
    const columns = await harness?.adminDb.execute(sql`
      select table_name, column_name from information_schema.columns
      where table_schema = 'public'
        and (
          (table_name = 'auth_users' and column_name = 'two_factor_enabled')
          or (table_name = 'auth_two_factor'
              and column_name in ('verified', 'failed_verification_count', 'locked_until'))
        )
    `);

    expect([...(columns ?? [])]).toHaveLength(4);
  });
});
