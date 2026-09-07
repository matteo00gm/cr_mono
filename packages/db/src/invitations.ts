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
  /*
   * An ISO string with an explicit cast, never the `Date` itself.
   *
   * postgres-js binds prepared-statement parameters as text and throws
   * ERR_INVALID_ARG_TYPE when a Date reaches it through a raw sql template —
   * drizzle's query *builder* converts one, its sql *tag* does not. The throw
   * is at bind time against a real connection, so no unit test with a fake
   * transaction can see it. CI's Postgres is what found it.
   *
   * Hoisted out of the template on purpose: a block comment inside one is
   * literal text, and the backticks this explanation wants would end the
   * string. That cost a parse error before it cost anything else.
   */
  const expiresAt = invitation.expiresAt.toISOString();

  const rows = await tx.execute(sql`
    INSERT INTO invitations (tenant_id, email, role, token_hash, invited_by, expires_at)
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${invitation.email},
      ${invitation.role},
      ${invitation.tokenHash},
      ${invitation.invitedBy},
      ${expiresAt}::timestamptz
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

/**
 * The tenant's invitations that are still open (P0-51, E8).
 *
 * Open only — accepted and revoked rows are history, and a members screen that
 * listed them would show an owner a growing list of things they cannot act on.
 * The `revoked_at` column stays for the audit trail; the *screen* is about what
 * is outstanding.
 *
 * **`token_hash` is not selected**, and that is not an oversight to tidy up
 * later: the hash is the credential's shadow, and a list endpoint that returns
 * it hands anyone with `members:manage` the material to attack it offline.
 * There is nothing a caller can do with it that they cannot do better by
 * revoking and re-inviting.
 *
 * Named `PendingInvitation` rather than `OpenInvitation` because
 * `with-invitation.ts` already exports the latter for the row the *acceptance*
 * path matches — a different shape for a different purpose, and two types with
 * one name in the same package surface is how a caller ends up using the wrong
 * one and finding out at runtime.
 */
export interface PendingInvitation {
  readonly id: string;
  readonly email: string;
  readonly role: string;
  readonly invitedBy: string;
  readonly expiresAt: Date;
  readonly createdAt: Date;
}

export const readOpenInvitations = async (
  tx: DbTransaction,
): Promise<readonly PendingInvitation[]> => {
  const rows = await tx.execute(sql`
    SELECT id, email, role, invited_by, expires_at, created_at
    FROM invitations
    WHERE accepted_at IS NULL AND revoked_at IS NULL
    ORDER BY created_at DESC
  `);

  return [...rows].map((row) => {
    const r = row as {
      id: string;
      email: string;
      role: string;
      invited_by: string;
      expires_at: Date;
      created_at: Date;
    };

    return {
      id: r.id,
      email: r.email,
      role: r.role,
      invitedBy: r.invited_by,
      expiresAt: r.expires_at,
      createdAt: r.created_at,
    };
  });
};

/**
 * Withdraws an open invitation.
 *
 * **Stamps `revoked_at` rather than deleting the row.** Two reasons, and the
 * second is the one that decides it: the partial unique index covers only open
 * rows, so a stamped row does not block a fresh invitation to the same address
 * — and an invitation that was sent and withdrawn is a thing that happened,
 * which a members screen may never show but an incident review will want.
 *
 * Returns the address, so the caller can put it in the audit row without a
 * second read — and `undefined` when nothing matched, which the caller turns
 * into 404 rather than pretending success.
 */
export const revokeInvitation = async (
  tx: DbTransaction,
  id: string,
): Promise<string | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE invitations
    SET revoked_at = now()
    WHERE id = ${id}::uuid AND accepted_at IS NULL AND revoked_at IS NULL
    RETURNING email
  `);

  const row = [...rows][0] as { email?: string } | undefined;
  return row?.email;
};
