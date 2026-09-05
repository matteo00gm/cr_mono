import type { MembershipReader } from '@catalogorosso/core';
import { publicRoute, requires, type RouteAccess } from '@catalogorosso/security';
import { contextResponse, meResponse, surfaceResponse } from '@catalogorosso/api-client';
import { Hono } from 'hono';
import { z } from 'zod';

import type { AppEnv } from '../env.js';
import { mountAuthRoutes, requireUser, type AuthPort } from '../middleware/auth.js';
import { requireCapability, routeKey } from '../middleware/capability.js';
import { resolveTenant } from '../middleware/tenant.js';
import { AUTH_ROUTE_PREFIX, DASHBOARD_PREFIX } from '../routes.js';

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
  app.get('/context', requireCapability('catalog:read'), (c) =>
    c.json({ tenantId: c.get('tenantId'), role: c.get('role') }),
  );

  return app;
};

/**
 * Every dashboard route, keyed by `METHOD <mounted path>`.
 *
 * **Separate from the registrations above, deliberately.** Metadata attached
 * inline disappears with the route it decorated; a table can be enumerated,
 * diffed and cross-checked — which is what P0-49's boot check does, what
 * P0-50's role x endpoint matrix walks, and what P0-62 generates the OpenAPI
 * document from. Adding a route without adding a line here is a **startup
 * failure**, not a silent default to open.
 *
 * The paths carry the mount prefix because that is how Hono reports them from
 * `app.routes`; deriving both from the same constant is what stops the two
 * drifting when the surface moves.
 *
 * `summary`, `description` and `example` exist for P0-62 and are required
 * rather than optional: a reference where half the routes are blank is
 * decorative, so the generator refuses one exactly as the boot check refuses an
 * undeclared route.
 */
export interface RouteDoc {
  readonly access: RouteAccess;
  /** One line. What a caller gets. */
  readonly summary: string;
  /** Why a caller would use it, and anything surprising about the answer. */
  readonly description: string;
  /** A representative success body. Concrete values, never `"string"`. */
  readonly example: unknown;
  /**
   * The success response, as a schema (P0-63).
   *
   * Required, and this is what makes a generated client worth having: the types
   * both consumers compile against come from here, so a breaking change to a
   * response fails typecheck in the widget and the dashboard at build time
   * rather than surfacing as a runtime error in a seller's storefront.
   *
   * An example alone cannot do that. It says what one answer looked like, not
   * what any answer must look like.
   */
  readonly response: z.ZodType;
}

export const DASHBOARD_ROUTES: ReadonlyMap<string, RouteDoc> = new Map<string, RouteDoc>([
  [
    routeKey('GET', DASHBOARD_PREFIX),
    {
      access: publicRoute(
        'Surface marker. Reports which app answered and nothing else - no tenant, ' +
          'no user, no data. P0-46 uses it to prove the two surfaces are distinct.',
      ),
      summary: 'Identify the dashboard surface',
      description:
        'Returns the name of the route surface that handled the request. It exists so a ' +
        'caller - or a test - can prove *which* application answered, rather than only ' +
        'that something did. Carries no tenant, user or catalogue data.',
      example: { surface: 'dashboard' },
      response: surfaceResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/me`),
    {
      access: publicRoute(
        'Authenticated but pre-tenant, by necessity: a user with several memberships ' +
          'cannot choose from a list they are not allowed to fetch. It returns only the ' +
          "caller's own identity and memberships, which RLS scopes to them (P0-47).",
      ),
      summary: 'The caller and the wineries they belong to',
      description:
        'Authenticated, but resolved before a tenant is chosen - a user who belongs to ' +
        'several wineries cannot pick one from a list they are not allowed to fetch. The ' +
        'memberships returned are scoped by Row Level Security to the caller, so this ' +
        'cannot be used to enumerate anybody else. Send the chosen tenant back on ' +
        'subsequent requests in the active-tenant header.',
      example: {
        userId: 'user_matteo',
        memberships: [
          { tenantId: '9f2c1b7e-4a30-4c1a-9f2e-1b7e4a304c1a', role: 'OWNER' },
          { tenantId: 'c3d5a881-6b12-4f77-9a10-6b124f779a10', role: 'EDITOR' },
        ],
      },
      response: meResponse,
    },
  ],
  [
    routeKey('GET', `${DASHBOARD_PREFIX}/context`),
    {
      access: requires('catalog:read'),
      summary: 'The resolved tenant and role for this request',
      description:
        'Reports what the server decided the request is scoped to. The tenant comes from ' +
        'a `memberships` row for the authenticated user and never from request input; the ' +
        'role comes from that same row, so a user who is EDITOR on one winery and OWNER ' +
        'on another gets the right one for the winery in play.',
      example: { tenantId: '9f2c1b7e-4a30-4c1a-9f2e-1b7e4a304c1a', role: 'EDITOR' },
      response: contextResponse,
    },
  ],
]);

/**
 * The access half of the table, for the callers that only need that.
 *
 * Derived rather than maintained separately - two tables that must agree are
 * two tables that will not.
 */
export const DASHBOARD_ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = new Map(
  [...DASHBOARD_ROUTES].map(([key, doc]) => [key, doc.access]),
);

/**
 * A route's response as JSON Schema, for the OpenAPI document (P0-62, P0-63).
 *
 * Converted here rather than in `scripts/gen-openapi.mjs` because this is where
 * `zod` is a declared dependency — a script reaching for it through pnpm's
 * isolated `node_modules` would resolve by luck.
 */
export const responseJsonSchema = (doc: RouteDoc): unknown =>
  z.toJSONSchema(doc.response, { io: 'output' });
