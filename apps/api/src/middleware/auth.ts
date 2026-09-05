import { UnauthenticatedError } from '@catalogorosso/core';
import type { Hono, MiddlewareHandler } from 'hono';

import { setRequestUser } from '../context.js';
import type { AppEnv } from '../env.js';

/**
 * Session middleware for the dashboard surface (P0-45).
 *
 * **This attaches `{ userId }` and nothing else — no tenant, no role.** Tenant
 * identity is resolved from `memberships` in P0-47 and must never come from a
 * request, and role must come from the *same membership row* as the tenant. A
 * middleware that helpfully attached a role here would be attaching a property
 * of the user, and a user who is EDITOR on one winery and OWNER on another is
 * entirely legitimate — so the authorization boundary stays in one place, and
 * this is not it.
 */

/**
 * The slice of Better Auth this app actually uses.
 *
 * A port rather than Better Auth's own `Auth` type, and that is deliberate.
 * Two things follow from it: `apps/api` never imports the library — the
 * configuration stays the single concern of `packages/core/src/auth.ts`, which
 * is also the one file allowed to reach the database un-scoped — and every
 * assertion below runs against a fake, with no container and no `DATABASE_URL`.
 * Depending on the real type would mean constructing a real adapter, which
 * opens a connection at construction, to test a middleware that only ever calls
 * `getSession`.
 *
 * `createAuth()`'s return value satisfies this structurally, so nothing has to
 * be adapted at the composition root.
 */
export interface AuthPort {
  /** Better Auth's fetch handler, mounted below at `/auth/*`. */
  readonly handler: (request: Request) => Promise<Response>;
  readonly api: {
    readonly getSession: (input: { headers: Headers }) => Promise<{ user: { id: string } } | null>;
  };
}

/**
 * Mounts Better Auth's own endpoints — sign-in, sign-up, reset, and the rest.
 *
 * **Only ever on the dashboard sub-app.** The widget surface uses origin-bound
 * tokens (§3.4) and must not accept cookies at all, which is why P2-08 sets
 * `Access-Control-Allow-Credentials: false` there. The two surfaces are
 * separate `Hono` instances precisely so that this cannot leak across (P0-54),
 * and there is a test asserting the widget has no `/auth/*` route.
 */
export const mountAuthRoutes = (app: Hono<AppEnv>, auth: AuthPort, basePath: string): void => {
  /*
   * `c.req.raw`, not the Hono context. Better Auth speaks the Fetch API, so it
   * takes the underlying `Request` and returns a `Response` — no adapter, and
   * no chance of Hono's own body parsing having already consumed the stream.
   */
  app.all(`${basePath}/*`, (c) => auth.handler(c.req.raw));
};

/**
 * Rejects a request with no valid session, and attaches the user to the ones
 * that have.
 *
 * `UnauthenticatedError` rather than a 401 built here: the mapping from domain
 * failure to status code lives in one place (P0-55), and a handler that
 * constructs its own response is a handler that can construct a different one.
 *
 * **Register it after the public routes on the surface and before every
 * protected one.** Hono matches handlers in registration order, so a guard
 * below the route it guards never runs — and the route's own tests all still
 * pass (P0-54). That ordering is asserted in `auth.test.ts` rather than trusted.
 */
export const requireUser =
  (auth: AuthPort): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const session = await auth.api.getSession({ headers: c.req.raw.headers });

    if (!session) throw new UnauthenticatedError();

    c.set('userId', session.user.id);

    // So every log line for the rest of this request carries the user, without
    // any call site downstream knowing about it (P0-55).
    setRequestUser(session.user.id);

    await next();
  };
