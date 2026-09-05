import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { mountAuthRoutes, requireUser, type AuthPort } from '../middleware/auth.js';
import { AUTH_ROUTE_PREFIX } from '../routes.js';

/**
 * The dashboard surface — `/v1/dashboard/*` (P0-54, P0-45).
 *
 * Everything a signed-in seller does. Cookie-authenticated (P0-45),
 * tenant-scoped from `memberships` (P0-47), capability-checked (P0-49).
 *
 * **Its middleware stack must never reach the widget surface**, which is why
 * this is a separate `Hono` instance rather than a route group on a shared one.
 * Middleware registered on a parent app runs for every child, so the Better
 * Auth handler mounted below would sit in front of the public widget endpoints
 * too — and the widget deliberately accepts no cookies at all (§3.4, P2-08 sets
 * `Access-Control-Allow-Credentials: false`). Two instances make that
 * structural instead of a thing reviewers have to notice.
 */
export const createDashboardApp = ({ auth }: { auth: AuthPort }): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /*
   * ---- Public on this surface -------------------------------------------
   *
   * Registered above the guard, and that is load-bearing rather than
   * stylistic: Hono matches handlers in registration order and stops at the
   * first that responds, so anything here is reached without a session. Sign-in
   * cannot require a session, which is the whole reason the order exists.
   */

  /*
   * A surface marker, and the probe P0-46's surface-isolation group hangs off.
   * It reports which stack served the request, so a test can prove *which* app
   * answered rather than only that something did — the distinction that matters
   * when the bug being hunted is one surface answering for the other.
   */
  app.get('/', (c) => c.json({ surface: 'dashboard' as const }));

  /** Sign-in, sign-up, reset, verification, TOTP — all of Better Auth. */
  mountAuthRoutes(app, auth, AUTH_ROUTE_PREFIX);

  /*
   * ---- Everything below this line requires a session ---------------------
   *
   * A route added *above* this call is public, silently, and its own tests
   * would all still pass. `auth.test.ts` asserts both halves of the boundary:
   * that `/auth/*` is reachable without a session, and that a route registered
   * after the guard is not.
   */
  app.use('*', requireUser(auth));

  /**
   * Who the caller is — and deliberately not what they can do.
   *
   * The smallest possible proof that the session middleware works end to end,
   * and the route the dashboard shell (P0-57) needs before it can render
   * anything. P0-47 extends this with the tenant and role once those are
   * resolved from `memberships`; it does not belong here, because a role is a
   * property of a membership rather than of a user.
   */
  app.get('/me', (c) => c.json({ userId: c.get('userId') }));

  return app;
};
