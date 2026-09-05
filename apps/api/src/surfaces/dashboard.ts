import type { MembershipReader } from '@catalogorosso/core';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { mountAuthRoutes, requireUser, type AuthPort } from '../middleware/auth.js';
import { resolveTenant } from '../middleware/tenant.js';
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
export interface DashboardOptions {
  readonly auth: AuthPort;
  /** Reads the caller's memberships, under RLS. See `src/memberships.ts`. */
  readonly readMemberships: MembershipReader;
}

export const createDashboardApp = ({ auth, readMemberships }: DashboardOptions): Hono<AppEnv> => {
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
   * Who the caller is, and which wineries they belong to.
   *
   * **Above tenant resolution, deliberately.** A user with more than one
   * membership has to pick one, and they cannot pick from a list they are not
   * allowed to fetch — so this route has to work without an active tenant. It
   * is the dashboard shell's bootstrap call (P0-57).
   *
   * It reports no role at top level, on purpose. A role belongs to a
   * membership, not to a user, and a `role` field beside `userId` is the shape
   * that invites somebody to cache it per user and hand an EDITOR on one
   * winery OWNER powers on another.
   */
  app.get('/me', async (c) => {
    const memberships = await readMemberships(c.get('userId'));

    return c.json({ userId: c.get('userId'), memberships });
  });

  /*
   * ---- Everything below this line is scoped to one winery ----------------
   *
   * `tenantId` and `role` come from a single `memberships` row and are the only
   * source a handler may use. A route added above this call has no tenant, and
   * a `c.get('tenantId')` in it is undefined at runtime while typechecking
   * perfectly — which is why the routes that need one live below.
   */
  app.use('*', resolveTenant(readMemberships));

  /**
   * The active winery, as resolved — not as requested.
   *
   * Small, and it earns its place: it is the assertion P0-48 hangs off. A test
   * signs in as a member of tenant A, sends `x-active-tenant: B`, and reads the
   * effective tenant back from here — an assertion on returned data rather than
   * on a mock.
   */
  app.get('/context', (c) => c.json({ tenantId: c.get('tenantId'), role: c.get('role') }));

  return app;
};
