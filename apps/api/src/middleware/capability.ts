import { ForbiddenError } from '@catalogorosso/core';
import { can, type Capability, type RouteAccess } from '@catalogorosso/security';
import type { Hono, MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Capability enforcement, and the guard that stops a route being added without
 * one (P0-49).
 */

/**
 * Denies unless the caller's role holds the capability.
 *
 * The role comes from `c.get('role')`, which P0-47 read from the **same**
 * `memberships` row as the tenant. That pairing is what makes this check
 * meaningful: a role sourced anywhere else would be a property of the user, and
 * somebody who is EDITOR on one winery and OWNER on another would carry the
 * higher role into both.
 *
 * 403 rather than 404 here, and that is not in tension with §3.5. The caller is
 * a member of this tenant and already knows the resource exists — hiding the
 * refusal would only stop them understanding why their own account cannot do
 * something. §3.5's 404 is for a *tenant* they have no membership in, which
 * P0-47 already answered before this middleware ever runs.
 *
 * **The returned guard carries the capability it enforces** (P0-50), and that
 * tag is not decoration. Hono records one `app.routes` entry per handler, so the
 * matrix can find this middleware on a route and read back *which* capability is
 * actually wired — catching a route declared in the access table but never
 * guarded, and a route guarded with the wrong capability. Neither is visible
 * from behaviour alone when every role happens to hold the capability involved.
 */
export interface CapabilityGuard extends MiddlewareHandler<AppEnv> {
  readonly capability: Capability;
}

export const requireCapability = (capability: Capability): CapabilityGuard => {
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    if (!can(c.get('role'), capability)) {
      throw new ForbiddenError(`This role cannot ${capability.replace(':', ' ')}.`);
    }

    await next();
  };

  return Object.assign(guard, { capability });
};

/** The capability a handler enforces, or `undefined` if it is not a guard. */
export const capabilityOf = (handler: unknown): Capability | undefined =>
  typeof handler === 'function' && 'capability' in handler
    ? (handler as CapabilityGuard).capability
    : undefined;

/**
 * A route the router knows about, as Hono reports it.
 *
 * `app.routes` carries middleware registrations too — those appear with a `*`
 * path — so they are filtered out. What is left is the set of concrete
 * endpoints, with the mount prefix already applied.
 */
export interface RegisteredRoute {
  readonly method: string;
  readonly path: string;
  /** Set when this entry is a `requireCapability` guard rather than a handler. */
  readonly capability: Capability | undefined;
}

export const registeredRoutes = (app: Hono<AppEnv>): readonly RegisteredRoute[] =>
  app.routes
    .filter((route) => !route.path.includes('*'))
    .map((route) => ({
      method: route.method,
      path: route.path,
      capability: capabilityOf(route.handler),
    }));

export const routeKey = (method: string, path: string): string => `${method} ${path}`;

export class UndeclaredRouteError extends Error {
  constructor(routes: readonly string[]) {
    super(
      `These routes have no declared access:\n    ${routes.join('\n    ')}\n\n` +
        '  Every route must say what it requires — a capability, or `publicRoute(reason)`\n' +
        '  with a written reason. A route with no declaration fails closed at startup\n' +
        '  rather than serving traffic nobody decided to allow (P0-49).',
    );
    this.name = 'UndeclaredRouteError';
  }
}

/**
 * **Fails closed at boot**, which is the whole point of the row.
 *
 * A missing capability must be a startup failure, not a silent default to open.
 * The alternative — treating an undeclared route as public — is a mistake that
 * ships, serves traffic, and is only found by whoever goes looking. This throws
 * while the Lambda container is initialising, so the deployment fails loudly and
 * the previous version keeps serving.
 *
 * It is deliberately not the whole story: this checks that every route has an
 * *entry*, and P0-50 checks that every entry is *enforced*, by calling each
 * endpoint with each role. A declaration nobody wired up would pass here.
 */
export const assertEveryRouteDeclared = (
  app: Hono<AppEnv>,
  declared: ReadonlyMap<string, RouteAccess>,
  prefix: string,
): void => {
  const undeclared = registeredRoutes(app)
    .filter((route) => route.path.startsWith(prefix))
    .map((route) => routeKey(route.method, route.path))
    .filter((key) => !declared.has(key));

  if (undeclared.length > 0) throw new UndeclaredRouteError(undeclared);
};
