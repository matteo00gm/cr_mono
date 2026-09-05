import {
  ACTIVE_TENANT_HEADER,
  resolveMembership,
  setRequestTenant,
  type MembershipReader,
} from '@catalogorosso/core';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';

/**
 * Tenant resolution (P0-47).
 *
 * Runs after `requireUser`, and attaches `{ tenantId, role }` read from a
 * `memberships` row. **Every handler gets the tenant only from here**, and
 * every database call then goes through `withTenant(c.get('tenantId'), …)`.
 *
 * **This file is the only place in `apps/api` permitted to read a tenant id
 * from a request**, and P0-48's lint rule names it as the single exception.
 * What arrives in the header is a *selection among rows the database already
 * agrees exist* — re-validated on every request against the caller's actual
 * memberships — not an assertion of identity. A forged or stale value fails;
 * it is never trusted.
 *
 * The header is deliberately not signed. Signing would protect a value that is
 * re-checked against the database anyway, so it would add a key to rotate and
 * a failure mode to debug in exchange for nothing: the security property comes
 * from the re-validation, not from the transport.
 */
export const resolveTenant =
  (read: MembershipReader): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const membership = await resolveMembership({
      userId: c.get('userId'),
      // The one sanctioned read of a tenant id from a request, in the whole app.
      requestedTenantId: c.req.header(ACTIVE_TENANT_HEADER),
      read,
    });

    /*
     * Both, from the same object, which came from one row.
     *
     * Setting them separately — or resolving the tenant here and the role
     * somewhere else — is how a user who is EDITOR on one winery and OWNER on
     * another ends up with OWNER on both. Role is never a property of a user.
     */
    c.set('tenantId', membership.tenantId);
    c.set('role', membership.role);

    // So every log line for the rest of the request carries the tenant (P0-55).
    setRequestTenant(membership.tenantId);

    await next();
  };
