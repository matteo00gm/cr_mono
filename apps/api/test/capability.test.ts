import {
  ALL_CAPABILITIES,
  can,
  requires,
  ROLES,
  type Capability,
  type Role,
  type RouteAccess,
} from '@catalogorosso/security';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { AppEnv } from '../src/env.js';
import { errorHandler } from '../src/middleware/error.js';
import {
  assertEveryRouteDeclared,
  registeredRoutes,
  requireCapability,
  routeKey,
  UndeclaredRouteError,
} from '../src/middleware/capability.js';
import { DASHBOARD_PREFIX } from '../src/routes.js';
import { DASHBOARD_ROUTE_ACCESS } from '../src/surfaces/dashboard.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * Capability enforcement and the fail-closed boot check (P0-49).
 *
 * The truth table itself is tested in `packages/security`, where it lives. What
 * is tested here is that it is actually *wired*: that the middleware denies, and
 * that a route added without a declaration stops the app from starting at all.
 */

const body = async (response: Response): Promise<Record<string, unknown>> =>
  (await response.json()) as Record<string, unknown>;

describe('requireCapability', () => {
  /** A minimal surface with the real error handler, so statuses are real. */
  const app = (role: Role, capability: Capability) => {
    const guarded = new Hono<AppEnv>();
    guarded.onError(errorHandler);
    guarded.use('*', async (c, next) => {
      c.set('role', role);
      await next();
    });
    guarded.get('/', requireCapability(capability), (c) => c.text('allowed'));
    return guarded;
  };

  it('allows a role that holds the capability', async () => {
    expect((await app('EDITOR', 'catalog:write').request('/')).status).toBe(200);
  });

  it('denies a role that does not, with 403', async () => {
    /*
     * An EDITOR maintains a catalogue; billing changes what the account costs.
     *
     * 403 rather than 404, and that is not in tension with §3.5: the caller is
     * a member of this tenant and already knows the resource exists, so hiding
     * the refusal would only stop them understanding why their own account
     * cannot do something. §3.5's 404 is for a *tenant* they have no membership
     * in, which P0-47 answered before this middleware ever ran.
     */
    const response = await app('EDITOR', 'billing:manage').request('/');

    expect(response.status).toBe(403);
    expect((await body(response)).error).toMatchObject({ code: 'forbidden' });
  });

  it('does not leak the capability list in the refusal', async () => {
    // Naming the one capability the caller lacks is useful; enumerating what
    // they would need to hold is a map of the authorisation model.
    const response = await app('EDITOR', 'billing:manage').request('/');
    const raw = JSON.stringify(await body(response));

    expect(raw).not.toContain('OWNER');
    expect(raw).not.toContain('catalog:write');
  });

  it('runs the whole matrix against the real middleware', async () => {
    /*
     * Every role against every capability, through actual HTTP rather than
     * through `can()` directly — so a middleware that read the wrong context
     * key, or forgot to call `can` at all, fails here even though the truth
     * table in `packages/security` still passes.
     */
    for (const role of ROLES) {
      for (const capability of ALL_CAPABILITIES) {
        const expected = can(role, capability) ? 200 : 403;
        const response = await app(role, capability).request('/');

        expect(response.status, `${role} / ${capability}`).toBe(expected);
      }
    }
  });
});

describe('the boot check', () => {
  const declared = new Map<string, RouteAccess>([
    [routeKey('GET', '/v1/dashboard/known'), requires('catalog:read')],
  ]);

  const withRoutes = (paths: readonly string[]): Hono<AppEnv> => {
    const app = new Hono<AppEnv>();
    for (const path of paths) app.get(path, (c) => c.text('x'));
    return app;
  };

  /** Returns what the check threw, or `undefined` if it passed. */
  const check = (app: Hono<AppEnv>, prefix = '/v1/dashboard'): unknown => {
    try {
      assertEveryRouteDeclared(app, declared, prefix);
      return undefined;
    } catch (error: unknown) {
      return error;
    }
  };

  it('passes when every route is declared', () => {
    expect(check(withRoutes(['/v1/dashboard/known']))).toBeUndefined();
  });

  it('throws when a route is not', () => {
    /*
     * The property the whole row exists for. A missing capability must be a
     * **startup** failure, not a silent default to open — the alternative is a
     * route that ships, serves traffic, and is found by whoever goes looking.
     */
    const error = check(withRoutes(['/v1/dashboard/known', '/v1/dashboard/forgotten']));

    expect(error).toBeInstanceOf(UndeclaredRouteError);
  });

  it('names the offending route, so the failure is actionable', () => {
    // A boot failure that says only "something is wrong" costs an hour.
    const error = check(withRoutes(['/v1/dashboard/forgotten']));

    expect((error as Error).message).toContain('GET /v1/dashboard/forgotten');
  });

  it('ignores routes outside the guarded surface', () => {
    // The widget has its own model (origin-bound tokens, §3.4) and no roles at
    // all, so a capability table has nothing to say about it.
    expect(check(withRoutes(['/v1/widget/config']))).toBeUndefined();
  });

  it('ignores middleware registrations', () => {
    /*
     * `app.routes` carries `use()` calls too, as `ALL <path>/*`. Counting them
     * as endpoints would demand a capability for the session guard itself and
     * make the check impossible to satisfy.
     */
    const app = new Hono<AppEnv>();
    app.use('/v1/dashboard/*', async (_c, next) => next());
    app.get('/v1/dashboard/known', (c) => c.text('x'));

    expect(registeredRoutes(app)).toHaveLength(1);
    expect(check(app)).toBeUndefined();
  });
});

describe('the real app', () => {
  const build = (): unknown => {
    try {
      return createApp({ auth: signedIn(), readMemberships: oneMembership() });
    } catch (error: unknown) {
      return error;
    }
  };

  it('starts, which means every dashboard route is declared', () => {
    // Not a tautology: `createApp` runs the check, so this failing is exactly
    // how somebody finds out they added a route without a decision.
    expect(build()).not.toBeInstanceOf(Error);
  });

  it('refuses once an undeclared route is added to the surface', () => {
    /*
     * The scratch-commit experiment, made permanent. A route registered on the
     * dashboard surface with no entry in the access table stops the app from
     * being constructed at all.
     */
    const app = createApp({ auth: signedIn(), readMemberships: oneMembership() });
    app.get(`${DASHBOARD_PREFIX}/sneaked-in`, (c) => c.text('x'));

    let error: unknown;
    try {
      assertEveryRouteDeclared(app, DASHBOARD_ROUTE_ACCESS, DASHBOARD_PREFIX);
    } catch (caught: unknown) {
      error = caught;
    }

    expect(error).toBeInstanceOf(UndeclaredRouteError);
    expect((error as Error).message).toContain('sneaked-in');
  });

  it('gives every public route a written reason rather than a blank', () => {
    /*
     * The escape hatch has to stay expensive. `publicRoute(reason)` is a
     * sentence a reviewer can disagree with; an empty string would turn the
     * declaration back into the absence it replaced.
     */
    for (const [key, access] of DASHBOARD_ROUTE_ACCESS) {
      if (access.kind !== 'public') continue;
      expect(access.reason.length, key).toBeGreaterThan(40);
    }
  });
});
