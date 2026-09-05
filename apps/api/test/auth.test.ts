import { Hono } from 'hono';
import { describe, expect, it, vi } from 'vitest';

import { createApp } from '../src/app.js';
import { AUTH_PUBLIC_PATH, DASHBOARD_PREFIX, WIDGET_PREFIX } from '../src/routes.js';
import { runWithRequestContext } from '../src/context.js';
import type { AppEnv } from '../src/env.js';
import { requireUser } from '../src/middleware/auth.js';
import { logger } from '../src/middleware/logger.js';
import { loggerOptions } from '../src/middleware/logger.js';
import { createDashboardApp } from '../src/surfaces/dashboard.js';
import { createWidgetApp } from '../src/surfaces/widget.js';
import { fakeAuth, signedIn } from './support/auth.js';
import { pino, type Logger, type LoggerOptions } from 'pino';

/**
 * Session middleware and the auth mount (P0-45).
 *
 * What is tested here is *our wiring*, not Better Auth. Cookie parsing,
 * signature checks, the cookie cache and expiry are the library's, and P0-46
 * exercises them against a real database and a real cookie. What can go wrong
 * on our side is placement — a guard mounted below the route it guards, or an
 * auth handler mounted on the wrong surface — and neither is visible from the
 * route's own tests.
 */

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('the auth mount', () => {
  it('serves Better Auth under /auth on the dashboard', async () => {
    const auth = fakeAuth();
    const app = createApp({ auth });

    const response = await app.request(`${AUTH_PUBLIC_PATH}/sign-in/email`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    /*
     * The path Better Auth receives is the *full* one — Hono hands over
     * `c.req.raw`, whose URL is not rewritten by the mount. This assertion is
     * the reason `basePath` is configured as `/v1/dashboard/auth` rather than
     * `/auth`: with the shorter value the library matches nothing and every
     * auth endpoint 404s, and it emails reset links that go nowhere.
     */
    expect(auth.handled).toEqual([`${AUTH_PUBLIC_PATH}/sign-in/email`]);
    expect(AUTH_PUBLIC_PATH.startsWith(DASHBOARD_PREFIX)).toBe(true);
  });

  it('is reachable without a session, which is the whole point', async () => {
    /*
     * Sign-in cannot require a sign-in. `/auth/*` is registered above the
     * guard, and Hono stops at the first handler that responds — so the order
     * of those two registrations is the only thing making login possible. It
     * is asserted rather than commented because reordering them would break
     * authentication entirely while every other test still passed.
     */
    const auth = fakeAuth({ user: null });

    const response = await createApp({ auth }).request(`${AUTH_PUBLIC_PATH}/sign-up`, {
      method: 'POST',
    });

    expect(response.status).toBe(200);
    expect(auth.sessionReads()).toBe(0);
  });

  it('is never mounted on the widget surface', async () => {
    /*
     * The widget authenticates with origin-bound tokens and must not accept
     * cookies at all (§3.4; P2-08 sets `Access-Control-Allow-Credentials:
     * false`). Two authentication systems on one API is where confusion bugs
     * live, so this asserts the absence directly.
     */
    const auth = fakeAuth();

    const response = await createApp({ auth }).request(`${WIDGET_PREFIX}/auth/sign-in/email`, {
      method: 'POST',
    });

    expect(response.status).toBe(404);
    expect(auth.handled).toEqual([]);
  });

  it('leaves the widget surface with no session read at all', async () => {
    const auth = fakeAuth();

    await createApp({ auth }).request('/v1/widget');

    expect(auth.sessionReads()).toBe(0);
  });
});

describe('requireUser', () => {
  it('rejects a request with no session', async () => {
    const response = await createApp({ auth: fakeAuth() }).request('/v1/dashboard/me');

    expect(response.status).toBe(401);
    expect((await body(response)).error).toMatchObject({ code: 'unauthenticated' });
  });

  it('attaches the user id to a request that has one', async () => {
    const response = await createApp({ auth: signedIn('user_matteo') }).request('/v1/dashboard/me');

    expect(response.status).toBe(200);
    expect(await body(response)).toEqual({ userId: 'user_matteo' });
  });

  it('attaches the user and nothing else', async () => {
    /*
     * The constraint the plan states twice. Tenant and role are P0-47's, read
     * together from one `memberships` row — and a role attached here would be a
     * property of the *user*, which is wrong: somebody who is EDITOR on one
     * winery and OWNER on another is entirely legitimate, and caching their
     * role per user grants them OWNER on both.
     */
    const response = await createApp({ auth: signedIn() }).request('/v1/dashboard/me');

    expect(Object.keys(await body(response))).toEqual(['userId']);
  });

  it('answers 401 before 404 on an unknown dashboard path', async () => {
    /*
     * Deliberate, and a change from before the guard existed.
     *
     * An anonymous caller getting 404 for a path that does not exist and 401
     * for one that does can map the dashboard's entire route table without
     * ever signing in. The guard matching `*` means every unmatched path under
     * this surface answers the same way, which is the same reasoning as §3.5's
     * "cross-tenant id returns 404, not 403" — read in the other direction.
     */
    const app = createApp({ auth: fakeAuth() });

    expect((await app.request('/v1/dashboard/me')).status).toBe(401);
    expect((await app.request('/v1/dashboard/no-such-route')).status).toBe(401);
  });

  it('does not run for routes registered above it', async () => {
    // The other half of the ordering contract: the surface marker and `/auth/*`
    // sit above the guard on purpose, and must stay reachable.
    const auth = fakeAuth();

    expect((await createApp({ auth }).request('/v1/dashboard')).status).toBe(200);
    expect(auth.sessionReads()).toBe(0);
  });

  it('reads the session once per request, not once per route', async () => {
    // A guard registered per-route rather than once would multiply database
    // reads by the number of matching handlers.
    const auth = signedIn();

    await createApp({ auth }).request('/v1/dashboard/me');

    expect(auth.sessionReads()).toBe(1);
  });

  it('passes the request headers through, since the cookie is in them', async () => {
    const seen: Headers[] = [];
    const app = new Hono<AppEnv>();
    app.use(
      '*',
      requireUser({
        handler: () => Promise.resolve(new Response()),
        api: {
          getSession: ({ headers }) => {
            seen.push(headers);
            return Promise.resolve({ user: { id: 'u1' } });
          },
        },
      }),
    );
    app.get('/', (c) => c.text(c.get('userId')));

    await app.request('/', { headers: { cookie: 'better-auth.session_token=abc' } });

    expect(seen[0]?.get('cookie')).toBe('better-auth.session_token=abc');
  });
});

describe('the user on the log line', () => {
  it('is attached to the request context, so later lines carry it', async () => {
    /*
     * Without this, every log line for an authenticated request is anonymous —
     * and "which user did this" becomes a question the logs cannot answer, which
     * is the same reason `tenantId` is on the context in P0-55.
     */
    const lines: { userId?: string }[] = [];
    const options: LoggerOptions = { ...loggerOptions, level: 'trace' };
    const log: Logger = pino(options, {
      write: (chunk: string) => lines.push(JSON.parse(chunk) as { userId?: string }),
    });

    const app = new Hono<AppEnv>();
    app.use('*', requireUser(signedIn('user_matteo')));
    app.get('/', (c) => {
      log.info('inside the handler');
      return c.text('ok');
    });

    await runWithRequestContext({ requestId: 'r1' }, () => app.request('/'));

    expect(lines[0]?.userId).toBe('user_matteo');
  });
});

describe('the dashboard surface in isolation', () => {
  it('guards its own routes even when mounted somewhere unexpected', async () => {
    // The guard belongs to the surface, not to where it happens to be mounted.
    const app = new Hono();
    app.route('/somewhere/else', createDashboardApp({ auth: fakeAuth() }));

    // No error handler on this bare parent, so the domain error surfaces as
    // Hono's own 500 rather than a 401 — what matters is that the guarded route
    // did not answer 200 just because it was mounted somewhere else.
    const response = await app.request('/somewhere/else/me');

    expect(response.status).not.toBe(200);
  });

  it('and the widget surface guards nothing, by design', async () => {
    const response = await createWidgetApp().request('/');

    expect(response.status).toBe(200);
  });
});

describe('a failing session read', () => {
  it('does not become a 401', async () => {
    /*
     * The distinction that matters when the database is down. A `getSession`
     * that *throws* is not a signed-out user — telling the caller "you are not
     * authenticated" would send them to sign in again, where they would fail
     * for the same reason, and the real fault would never be reported.
     */
    vi.spyOn(logger, 'error').mockImplementation(() => undefined);

    const app = createApp({
      auth: {
        handler: () => Promise.resolve(new Response()),
        api: { getSession: () => Promise.reject(new Error('connection terminated')) },
      },
    });

    const response = await app.request('/v1/dashboard/me');

    expect(response.status).toBe(500);
    expect((await body(response)).error).toMatchObject({ code: 'internal' });

    vi.restoreAllMocks();
  });
});
