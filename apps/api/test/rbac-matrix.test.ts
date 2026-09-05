import { ALL_CAPABILITIES, can, ROLES, requires, type Role } from '@catalogorosso/security';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import {
  registeredRoutes,
  requireCapability,
  routeKey,
  type RegisteredRoute,
} from '../src/middleware/capability.js';
import { errorHandler, normaliseThrown } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/logger.js';
import { DASHBOARD_PREFIX } from '../src/routes.js';
import { createDashboardApp, DASHBOARD_ROUTE_ACCESS } from '../src/surfaces/dashboard.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The generated role × endpoint matrix (P0-50).
 *
 * **Routes are enumerated from the router, never from memory.** That is the
 * whole idea: a hand-written list of endpoints to check is a list that falls
 * behind the day somebody adds one, and the endpoint nobody remembered is
 * exactly the endpoint nobody protected.
 *
 * Three distinct failures are caught here, and they are not the same failure:
 *
 * 1. A route with **no entry** in the access table (also a boot failure, P0-49).
 * 2. A route with an entry that is **never wired** to a guard — or wired to the
 *    *wrong* capability. Invisible from behaviour whenever every role happens to
 *    hold the capability involved, which is true of `catalog:read` today.
 * 3. A route that **behaves** differently from what its entry claims.
 *
 * *(Note for P4-03a and any other route performing outbound fetches: those also
 * need the `guardedFetch` agent, not just a capability entry. This matrix has
 * nothing to say about egress.)*
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

/** The app under test, signed in as `role` with a membership carrying it. */
const appAs = (role: Role) =>
  createApp({ auth: signedIn(), readMemberships: oneMembership(TENANT, role) });

/** Every concrete dashboard endpoint, deduplicated across handler entries. */
const endpoints = (): readonly { method: string; path: string }[] => {
  const app = appAs('OWNER');
  const seen = new Map<string, { method: string; path: string }>();

  for (const route of registeredRoutes(app)) {
    if (!route.path.startsWith(DASHBOARD_PREFIX)) continue;
    seen.set(routeKey(route.method, route.path), { method: route.method, path: route.path });
  }

  return [...seen.values()];
};

/** Capabilities actually enforced on a path, read off the registered guards. */
const guardsOn = (path: string, method: string): readonly string[] =>
  registeredRoutes(appAs('OWNER'))
    .filter(
      (route: RegisteredRoute) =>
        route.path === path && route.method === method && route.capability !== undefined,
    )
    .map((route) => route.capability as string);

describe('the route table itself', () => {
  it('is not empty, or every assertion below is vacuous', () => {
    // The failure mode this whole file could otherwise have: enumerate nothing,
    // pass everything, and report a fully protected API.
    expect(endpoints().length).toBeGreaterThan(0);
  });

  it('has an access entry for every registered endpoint', () => {
    /*
     * The assertion that gives the matrix teeth: **adding a route without a
     * capability fails CI**. It duplicates P0-49's boot check on purpose —
     * that one protects the deployment, this one protects the pull request,
     * and a reviewer sees this failure days earlier.
     */
    const missing = endpoints()
      .map((route) => routeKey(route.method, route.path))
      .filter((key) => !DASHBOARD_ROUTE_ACCESS.has(key));

    expect(missing).toEqual([]);
  });

  it('has no access entry for an endpoint that no longer exists', () => {
    /*
     * The other direction, and the one that rots quietly. A stale entry is not
     * a security hole, but it makes the table stop describing the system — and
     * a table nobody trusts is a table nobody checks against.
     */
    const registered = new Set(endpoints().map((route) => routeKey(route.method, route.path)));
    const orphaned = [...DASHBOARD_ROUTE_ACCESS.keys()].filter((key) => !registered.has(key));

    expect(orphaned).toEqual([]);
  });
});

describe('declarations are actually enforced', () => {
  it('wires a guard for every route declared as requiring a capability', () => {
    /*
     * Failure 2, and the reason the guard carries its capability as a tag. A
     * route can be listed in the access table and never guarded — the table is
     * just data — and behaviour cannot reveal it while every role holds the
     * capability in question, which is true of `catalog:read` right now.
     */
    for (const [key, access] of DASHBOARD_ROUTE_ACCESS) {
      if (access.kind !== 'capability') continue;

      const [method, path] = key.split(' ');
      expect(guardsOn(path ?? '', method ?? ''), key).toContain(access.capability);
    }
  });

  it('wires no guard on a route declared public', () => {
    // A guard on a route the table calls public means one of the two is lying,
    // and the table is what P0-62's OpenAPI and the dashboard's nav will read.
    for (const [key, access] of DASHBOARD_ROUTE_ACCESS) {
      if (access.kind !== 'public') continue;

      const [method, path] = key.split(' ');
      expect(guardsOn(path ?? '', method ?? ''), key).toEqual([]);
    }
  });
});

describe('the matrix', () => {
  const cases = endpoints().flatMap((route) =>
    ROLES.map((role) => {
      const access = DASHBOARD_ROUTE_ACCESS.get(routeKey(route.method, route.path));
      const allowed =
        access === undefined ? false : access.kind === 'public' || can(role, access.capability);

      return { ...route, role, allowed };
    }),
  );

  it.each(cases)(
    '$role on $method $path is allowed: $allowed',
    async ({ method, path, role, allowed }) => {
      /*
       * Called through the real app with a real session of that role, so this
       * exercises the whole chain — session guard, tenant resolution, capability
       * check — rather than the capability check alone.
       *
       * The assertion is on 403 specifically, not on 2xx. A route may legitimately
       * answer 404 or 422 for reasons that have nothing to do with authorisation,
       * and demanding a 200 would turn every unrelated change into an RBAC
       * failure. What is being asserted is: *was the caller refused for who they
       * are?*
       */
      const response = await appAs(role).request(path, { method });

      expect(
        response.status === 403,
        `${role} ${method} ${path} → ${String(response.status)}`,
      ).toBe(!allowed);
    },
  );

  it('covers every endpoint against every role', () => {
    expect(cases).toHaveLength(endpoints().length * ROLES.length);
  });
});

describe('the matrix catches what it claims to', () => {
  it('detects a route added with no declaration', () => {
    /*
     * The scratch-commit experiment, run in-process. Without this, a matrix
     * that silently enumerated nothing would look identical to a matrix that
     * found everything in order.
     */
    const app = appAs('OWNER');
    app.get(`${DASHBOARD_PREFIX}/undeclared`, (c) => c.text('x'));

    const missing = registeredRoutes(app)
      .filter((route) => route.path.startsWith(DASHBOARD_PREFIX))
      .map((route) => routeKey(route.method, route.path))
      .filter((key) => !DASHBOARD_ROUTE_ACCESS.has(key));

    expect(missing).toContain(`GET ${DASHBOARD_PREFIX}/undeclared`);
  });

  it('detects a route guarded with the wrong capability', () => {
    /*
     * Failure 2 in its subtler form. `requires('billing:manage')` in the table
     * against a `requireCapability('catalog:read')` on the route means an
     * EDITOR reaches an OWNER-only endpoint — and every functional test of that
     * endpoint still passes, because they run as an OWNER.
     */
    const app = appAs('OWNER');
    app.get(`${DASHBOARD_PREFIX}/mismatched`, requireCapability('catalog:read'), (c) =>
      c.text('x'),
    );

    const declaredCapability = requires('billing:manage').capability;
    const enforced = registeredRoutes(app)
      .filter(
        (route) =>
          route.path === `${DASHBOARD_PREFIX}/mismatched` && route.capability !== undefined,
      )
      .map((route) => route.capability);

    expect(enforced).not.toContain(declaredCapability);
    expect(enforced).toContain('catalog:read');
  });

  it('reads a capability back off a guard, which is what makes the above possible', () => {
    const app = appAs('OWNER');
    app.get(`${DASHBOARD_PREFIX}/probe`, requireCapability('keys:manage'), (c) => c.text('x'));

    expect(guardsOn(`${DASHBOARD_PREFIX}/probe`, 'GET')).toEqual([]);
    expect(
      registeredRoutes(app)
        .filter((route) => route.path === `${DASHBOARD_PREFIX}/probe`)
        .map((route) => route.capability),
    ).toContain('keys:manage');
  });
});

describe('the deny branch, against a real OWNER-only route', () => {
  /*
   * Worth building explicitly, because the live route set cannot exercise it:
   * every capability currently declared on a route is `catalog:read`, which
   * both roles hold. So the matrix above only ever asserts *allowed*, and a
   * `requireCapability` that had been quietly reduced to `next()` would sail
   * through it.
   *
   * This mounts the real dashboard surface — session guard, tenant resolution,
   * capability check, error handler — with one extra OWNER-only route, and
   * checks both directions through it.
   */
  const mounted = (role: Role, guarded: boolean) => {
    const dashboard = createDashboardApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, role),
    });

    if (guarded) {
      dashboard.get('/owner-only', requireCapability('billing:manage'), (c) => c.text('reached'));
    } else {
      dashboard.get('/owner-only', (c) => c.text('reached'));
    }

    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.use('*', normaliseThrown());
    app.onError(errorHandler);
    app.route(DASHBOARD_PREFIX, dashboard);

    return app;
  };

  it('refuses an EDITOR', async () => {
    const response = await mounted('EDITOR', true).request(`${DASHBOARD_PREFIX}/owner-only`);

    expect(response.status).toBe(403);
  });

  it('admits an OWNER', async () => {
    const response = await mounted('OWNER', true).request(`${DASHBOARD_PREFIX}/owner-only`);

    expect(response.status).toBe(200);
  });

  it('would let the EDITOR through if the guard were missing', async () => {
    /*
     * The negative control. Without it, the two assertions above could both
     * pass for reasons unrelated to the guard — a route that 403'd for everyone
     * looks identical to a route that 403s for the right people.
     */
    const response = await mounted('EDITOR', false).request(`${DASHBOARD_PREFIX}/owner-only`);

    expect(response.status).toBe(200);
  });
});

describe('coverage of the capability table', () => {
  it('reports which capabilities no route exercises yet', () => {
    /*
     * Not a failure — most of the table is for endpoints P1 and later build —
     * but worth asserting the *shape* of the gap rather than letting it be
     * invisible. When a capability finally gets a route, this list shrinks, and
     * a capability that never appears in it is one nobody wired up.
     */
    const used = new Set(
      [...DASHBOARD_ROUTE_ACCESS.values()]
        .filter((access) => access.kind === 'capability')
        .map((access) => access.capability),
    );
    const unused = ALL_CAPABILITIES.filter((capability) => !used.has(capability));

    // Every capability except `catalog:read` is waiting for its endpoints.
    expect(used).toContain('catalog:read');
    expect(unused.length).toBe(ALL_CAPABILITIES.length - used.size);
  });
});
