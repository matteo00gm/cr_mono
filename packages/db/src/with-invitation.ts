import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The invitation acceptance scope (P0-51).
 *
 * **The third and last RLS context**, after `withTenant` (P0-19) and `withUser`
 * (P0-47), and it exists for the same reason `withUser` does: there is one path
 * that must read a table before the caller is a member of the tenant it belongs
 * to. Accepting an invitation *is* that path — becoming a member is what the
 * request does, so requiring membership to read the row is circular.
 *
 * The alternative was an un-scoped connection, and it was rejected: it would
 * put a second table outside RLS in order to solve a problem inside it, and the
 * un-scoped connection would then exist for anything else to reach.
 *
 * What makes a token GUC safe where a tenant GUC would not be is that the value
 * is a **secret, not an identifier**. `app.tenant_id` must never come from a
 * request because naming a tenant is not evidence of anything; holding
 * 256 bits from a CSPRNG is. A caller without the token matches no row.
 *
 * The tenant is then set **from the row the database matched**, inside the same
 * transaction — so the membership write that follows is scoped by a value that
 * came out of Postgres rather than off the wire. That is the P0-48 invariant,
 * satisfied on a path that has no membership to read it from.
 */

export interface OpenInvitation {
  readonly id: string;
  readonly tenantId: string;
  readonly email: string;
  readonly role: string;
  /** The inviting user's id, carried onto the membership row. */
  readonly invitedBy: string;
  readonly expiresAt: Date;
}

/**
 * Runs `fn` inside a transaction scoped to one invitation, or resolves to
 * `undefined` when the token matches nothing usable.
 *
 * `undefined` rather than a thrown error, because "no such token", "already
 * accepted", "revoked" and "expired" must be indistinguishable to the caller —
 * the endpoint answers the same way to all four, so a valid-looking token
 * cannot be told apart from a spent one by anybody probing.
 *
 * The row is taken `FOR UPDATE`. That is what makes the token single-use under
 * concurrency: two simultaneous acceptances serialise on the lock, the second
 * one re-reads a row that now has `accepted_at` set, and its filter excludes it.
 */
export const withInvitation = async <T>(
  tokenHash: string,
  fn: (tx: DbTransaction, invitation: OpenInvitation) => Promise<T>,
  db: Database = getDb(),
): Promise<T | undefined> =>
  db.transaction(async (tx) => {
    /*
     * Transaction-local, like every other context here: without the third
     * argument the setting outlives the transaction on a pooled connection and
     * the next request inherits somebody else's invitation scope.
     */
    await tx.execute(sql`SELECT set_config('app.invitation_token', ${tokenHash}, true)`);

    const rows = await tx.execute(sql`
      SELECT id, tenant_id, email, role, invited_by, expires_at
      FROM invitations
      WHERE token_hash = ${tokenHash}
        AND accepted_at IS NULL
        AND revoked_at IS NULL
        AND expires_at > now()
      FOR UPDATE
    `);

    const row = [...rows][0] as
      | {
          id: string;
          tenant_id: string;
          email: string;
          role: string;
          invited_by: string;
          expires_at: Date;
        }
      | undefined;

    if (!row) return undefined;

    /*
     * The tenant comes from the row, never from the request. Set here rather
     * than by reopening with `withTenant` because reopening would be a second
     * transaction — and the lock taken above, which is what makes the token
     * single-use, is only held inside this one.
     */
    await tx.execute(sql`SELECT set_config('app.tenant_id', ${row.tenant_id}, true)`);

    return fn(tx, {
      id: row.id,
      tenantId: row.tenant_id,
      email: row.email,
      role: row.role,
      invitedBy: row.invited_by,
      expiresAt: row.expires_at,
    });
  });
