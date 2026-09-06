import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * The `invitations` statements (P0-51).
 *
 * All of them take the caller's transaction, for the reason `audit.ts` gives:
 * an invitation row and the email that announces it should not be able to
 * disagree about whether they happened. Every one runs inside a scope that has
 * already set `app.tenant_id` — `withTenant` for the invite side, and
 * `withInvitation` for acceptance, which sets it from the matched row.
 */

export interface NewInvitation {
  readonly email: string;
  readonly role: string;
  readonly tokenHash: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

/**
 * True when this address already belongs to the active tenant.
 *
 * The re-invite no-op the row asks for. The join is against `auth_users`, which
 * carries no `tenant_id` and no policy — but `memberships` does, and it is the
 * scoped side, so this cannot see membership of any other winery.
 */
export const emailIsMember = async (tx: DbTransaction, email: string): Promise<boolean> => {
  const rows = await tx.execute(sql`
    SELECT 1
    FROM memberships m
    JOIN auth_users u ON u.id = m.user_id
    WHERE u.email = ${email}
    LIMIT 1
  `);

  return [...rows].length > 0;
};

/**
 * Creates an invitation, or reports that an open one already exists.
 *
 * `ON CONFLICT DO NOTHING` against the partial unique index, so the second
 * invite of the same address is a no-op rather than a duplicate row — and a
 * duplicate row would mean two live tokens for one seat, only one of which
 * anybody remembers to revoke.
 *
 * Returns the new id, or `undefined` when nothing was inserted. The caller uses
 * that to decide whether to send an email: re-sending on every click would turn
 * an invite button into a way to mail somebody repeatedly through us.
 */
export const insertInvitation = async (
  tx: DbTransaction,
  invitation: NewInvitation,
): Promise<string | undefined> => {
  const rows = await tx.execute(sql`
    INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${invitation.email},
      ${invitation.role},
      ${invitation.tokenHash},
      ${invitation.invitedBy},
      ${invitation.expiresAt}
    )
    ON CONFLICT (tenant_id, email) WHERE accepted_at IS NULL AND revoked_at IS NULL
    DO NOTHING
    RETURNING id
  `);

  const row = [...rows][0] as { id?: string } | undefined;
  return row?.id;
};

/**
 * Stamps the invitation as redeemed.
 *
 * Runs inside `withInvitation`'s transaction, holding the `FOR UPDATE` lock
 * that read it — so this and the membership insert are one atomic step, and a
 * token cannot produce two memberships.
 */
export const markInvitationAccepted = async (tx: DbTransaction, id: string): Promise<void> => {
  await tx.execute(sql`UPDATE invitations SET accepted_at = now() WHERE id = ${id}`);
};

/**
 * Writes the membership the invitation promised.
 *
 * The role is passed by the caller from the *invitation row*, never from the
 * acceptance request — that is the escalation this endpoint would otherwise be.
 * `ON CONFLICT DO NOTHING` on the tenant/user pair, so accepting a second
 * invitation to a winery you already belong to leaves the role you have rather
 * than silently changing it.
 */
export const insertMembershipFromInvitation = async (
  tx: DbTransaction,
  membership: {
    readonly tenantId: string;
    readonly userId: string;
    readonly role: string;
    readonly invitedBy: string;
  },
): Promise<void> => {
  await tx.execute(sql`
    INSERT INTO memberships (tenant_id, user_id, role, invited_by)
    VALUES (
      ${membership.tenantId},
      ${membership.userId},
      ${membership.role}::membership_role,
      ${membership.invitedBy}
    )
    ON CONFLICT (tenant_id, user_id) DO NOTHING
  `);
};

/**
 * The active tenant's display name, for the invitation email.
 *
 * No `WHERE` clause, and that is not an omission: `tenants`' policy is
 * `id = app.tenant_id`, so inside `withTenant` this table holds exactly one
 * visible row. Adding a redundant predicate would suggest the isolation comes
 * from the query rather than from the policy, which is the wrong lesson for the
 * next person to copy.
 */
export const readActiveTenantName = async (tx: DbTransaction): Promise<string | undefined> => {
  const rows = await tx.execute(sql`SELECT name FROM tenants LIMIT 1`);
  const row = [...rows][0] as { name?: string } | undefined;

  return row?.name;
};
