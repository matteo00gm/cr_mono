import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * Changing and removing memberships, with the last-OWNER guard built in
 * (P0-52).
 *
 * **The guard is in the statement, not beside it.** A `canRemove()` helper the
 * caller is supposed to consult first is a guard with a bypass — the next
 * handler written in a hurry does the `UPDATE` directly and nothing fails.
 * Here there is no way to perform either write without the condition, because
 * the condition is part of the write.
 *
 * Locking a paying customer out of their own billing is an unrecoverable
 * support incident (§2.7): there is no self-service path back, because every
 * path back needs an OWNER.
 */

/**
 * What happened. Three outcomes rather than a boolean, because the caller has
 * to answer differently: a missing member is a 404, a refused change is a
 * 409, and conflating them either leaks whether a user exists in this tenant
 * or reports the wrong reason for a refusal the owner needs to understand.
 */
export type MemberWriteOutcome = 'changed' | 'no-such-member' | 'would-remove-last-owner';

/**
 * Locks every membership row for this tenant.
 *
 * **The reason this row is its own task.** Without the lock, two concurrent
 * demotions of two different owners each see the other still in place and both
 * succeed, leaving a winery nobody owns. The read that decides is the read that
 * must be locked, and it has to cover the *whole set* rather than the target
 * row — the other owner is what the decision depends on, and locking only the
 * row being changed leaves that free to disappear underneath it.
 *
 * `ORDER BY user_id` because two transactions locking the same set in different
 * orders deadlock. Postgres locks in the order rows are returned, so a stable
 * order makes the second transaction wait rather than fail.
 */
const lockRoster = async (tx: DbTransaction): Promise<void> => {
  await tx.execute(sql`
    SELECT 1 FROM memberships
    WHERE tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
    ORDER BY user_id
    FOR UPDATE
  `);
};

/** Does this tenant hold a membership for this user? Call with the lock held. */
const memberExists = async (tx: DbTransaction, userId: string): Promise<boolean> => {
  const rows = await tx.execute(sql`SELECT 1 FROM memberships WHERE user_id = ${userId} LIMIT 1`);
  return [...rows].length > 0;
};

/**
 * Changes a member's role.
 *
 * The tenant is never named: `memberships` is under RLS, so `WHERE user_id =`
 * inside `withTenant` reaches exactly this tenant's row (P0-19). Naming it
 * would be a second source of truth for something the policy already decides.
 */
export const setMemberRole = async (
  tx: DbTransaction,
  change: { readonly userId: string; readonly role: 'OWNER' | 'EDITOR' },
): Promise<MemberWriteOutcome> => {
  await lockRoster(tx);

  if (!(await memberExists(tx, change.userId))) return 'no-such-member';

  const rows = await tx.execute(sql`
    UPDATE memberships
    SET role = ${change.role}::membership_role, updated_at = now()
    WHERE user_id = ${change.userId}
      AND (
        -- Not an owner today: nothing to protect.
        role <> 'OWNER'
        -- Still an owner afterwards: a no-op, or a promotion.
        OR ${change.role} = 'OWNER'
        -- Somebody else owns this winery, so it does not become ownerless.
        OR EXISTS (
          SELECT 1 FROM memberships other
          WHERE other.user_id <> ${change.userId} AND other.role = 'OWNER'
        )
      )
    RETURNING user_id
  `);

  return [...rows].length > 0 ? 'changed' : 'would-remove-last-owner';
};

/**
 * Removes a member.
 *
 * Same guard, one clause shorter: there is no "still an owner afterwards" case
 * when the row is going away.
 */
export const removeMember = async (
  tx: DbTransaction,
  target: { readonly userId: string },
): Promise<MemberWriteOutcome> => {
  await lockRoster(tx);

  if (!(await memberExists(tx, target.userId))) return 'no-such-member';

  const rows = await tx.execute(sql`
    DELETE FROM memberships
    WHERE user_id = ${target.userId}
      AND (
        role <> 'OWNER'
        OR EXISTS (
          SELECT 1 FROM memberships other
          WHERE other.user_id <> ${target.userId} AND other.role = 'OWNER'
        )
      )
    RETURNING user_id
  `);

  return [...rows].length > 0 ? 'changed' : 'would-remove-last-owner';
};

/**
 * How many OWNERs this tenant has.
 *
 * Not used by the guard — the guard asks "is there another one", which is a
 * cheaper question and the one that actually decides. This exists for the
 * dashboard, so it can grey out the control before somebody clicks it: a
 * refusal after the fact is correct and still a worse experience than an
 * explanation before.
 */
export const countOwners = async (tx: DbTransaction): Promise<number> => {
  const rows = await tx.execute(
    sql`SELECT count(*)::int AS owners FROM memberships WHERE role = 'OWNER'`,
  );
  const row = [...rows][0] as { owners?: number } | undefined;

  return row?.owners ?? 0;
};
