import type { Role } from '@catalogorosso/security';

import { ForbiddenError, InvalidRequestError, NotFoundError } from './errors.js';

/**
 * Membership and tenant resolution (P0-47).
 *
 * **Tenant identity must never come from the request.** A `tenantId` in a body,
 * header or query is attacker-controlled; the only trustworthy source is a
 * `memberships` row for the authenticated user (§3.5).
 *
 * That does not mean the request may say *nothing*. A user can legitimately
 * belong to several wineries, so something has to choose between them — but
 * what the request supplies is a **selection among rows the database already
 * agrees exist**, re-validated on every request, not an assertion of identity.
 * The difference is the whole design: a forged or stale selection fails, it is
 * never trusted.
 */

/**
 * Re-exported, not redefined.
 *
 * `Role` is authorization vocabulary and lives in `packages/security` beside
 * the capability table (P0-49) — one definition, so a third role cannot be
 * added in one place and missed in the other. It is re-exported here because
 * `Membership` carries one and callers should not need two imports for one
 * concept.
 */
export type { Role };

export interface Membership {
  readonly tenantId: string;
  readonly role: Role;
}

/**
 * Reads the caller's memberships. One row per tenant they belong to.
 *
 * Injected rather than imported so this module stays free of a database, which
 * is what keeps its tests plain unit tests (the P0-09 boundary rule). The real
 * implementation runs inside `withUser`, where RLS admits exactly these rows.
 */
export type MembershipReader = (userId: string) => Promise<readonly Membership[]>;

/** The header carrying the caller's choice when they belong to more than one. */
export const ACTIVE_TENANT_HEADER = 'x-active-tenant';

export interface ResolveMembershipInput {
  readonly userId: string;
  /**
   * The tenant the caller says they are working in, or `undefined`.
   *
   * Untrusted by construction — see `resolveMembership` for what happens to it.
   */
  readonly requestedTenantId?: string | undefined;
  readonly read: MembershipReader;
}

/**
 * Resolves the active membership, or throws.
 *
 * **Tenant and role come from the same row, together**, and that is the subtle
 * half of this task — a distinct bug from trusting a client tenant id.
 * Consider a user who is `EDITOR` on Winery 1 and `OWNER` on Winery 2, which is
 * entirely legitimate. An implementation that resolves the tenant correctly but
 * carries a role cached per *user* grants that user `OWNER` powers on Winery 1.
 * **Role is never a property of a user.** Returning one object from one row is
 * what makes that mistake impossible to write rather than merely discouraged.
 */
export const resolveMembership = async ({
  userId,
  requestedTenantId,
  read,
}: ResolveMembershipInput): Promise<Membership> => {
  const memberships = await read(userId);

  if (memberships.length === 0) {
    /*
     * 403, not 404 — and the contrast with the case below is deliberate.
     *
     * There is no tenant being named here, so there is nothing whose existence
     * could leak. The caller is authenticated and simply belongs to nothing:
     * an invited user whose invitation was revoked, or an account created
     * before any winery was set up. Telling them so is honest and actionable.
     */
    throw new ForbiddenError('This account does not belong to any winery.');
  }

  if (requestedTenantId === undefined) {
    const [only] = memberships;

    // The overwhelmingly common case: one winery, no choice to make. Destructured
    // rather than indexed-and-asserted, so `noUncheckedIndexedAccess` does the
    // narrowing instead of a `!` that would survive the array becoming empty.
    if (memberships.length === 1 && only) return only;

    /*
     * Several memberships and no selection. Not an error to paper over with a
     * default — picking the first would silently write to a winery the user did
     * not mean, and "first" is whatever the query planner felt like.
     *
     * The dashboard learns its options from `/me`, which sits above this
     * middleware precisely so it can be called without an active tenant.
     */
    throw new InvalidRequestError(
      `Select an active winery and send it in the ${ACTIVE_TENANT_HEADER} header.`,
    );
  }

  const match = memberships.find((membership) => membership.tenantId === requestedTenantId);

  if (!match) {
    /*
     * **404, not 403** (§3.5).
     *
     * The natural implementation returns 403 — the caller asked for a tenant
     * they may not have — and that is exactly the enumeration oracle to avoid.
     * A 403 for an existing winery and a 404 for a made-up one lets anyone with
     * an account map which tenant ids are real. Answering 404 to both means the
     * response carries no information about existence.
     *
     * This is also the re-validation the whole selection mechanism rests on: a
     * stale header (membership since revoked) and a forged one (never held)
     * take the same path and get the same answer, on every request.
     */
    throw new NotFoundError('No such winery.');
  }

  return match;
};
