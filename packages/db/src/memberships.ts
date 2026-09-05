import { sql } from 'drizzle-orm';
import type { Database } from './client.js';
import { membershipRole } from './schema/memberships.js';
import { withUser } from './with-user.js';

/**
 * The caller's memberships, read under RLS (P0-47).
 *
 * Lives here rather than in `apps/api` for a reason the P0-09 rule caught
 * directly: writing this query in the app would mean the app importing
 * `drizzle-orm`, which is exactly what `no-raw-db-outside-with-tenant` forbids.
 * The right answer was not an exception — it was to put the query where queries
 * belong. The app imports a function; the decision made *with* the rows stays in
 * `packages/core`, which has no database at all.
 */

/** Mirrors the `membership_role` enum, so the two cannot drift silently. */
export type MembershipRole = (typeof membershipRole.enumValues)[number];

export interface UserMembership {
  readonly tenantId: string;
  readonly role: MembershipRole;
}

/**
 * Runs inside `withUser`, so `app.user_id` is set and `app.tenant_id` is not.
 *
 * The P0-37 policy then admits **exactly this user's rows**:
 *
 * ```sql
 * USING (tenant_id = app.tenant_id OR user_id = app.user_id)
 * ```
 *
 * The `WHERE user_id = …` below is belt and braces rather than the control. If
 * somebody deleted it the rows would be the same, because RLS scopes them; if
 * somebody deleted the policy, `with-user.integration.test.ts` fails. Two
 * independent reasons the answer is right is the point.
 *
 * **Tenant and role are selected together, in one query.** A second query for
 * the role — or a role cached per user — is how somebody who is EDITOR on one
 * winery and OWNER on another ends up with OWNER on both.
 */
export const readMembershipsForUser = (
  userId: string,
  db?: Database,
): Promise<readonly UserMembership[]> =>
  withUser(
    userId,
    async (tx) => {
      const rows = await tx.execute<{ tenant_id: string; role: MembershipRole }>(sql`
        select tenant_id, role
          from memberships
         where user_id = ${userId}
         order by created_at asc
      `);

      return [...rows].map((row): UserMembership => ({ tenantId: row.tenant_id, role: row.role }));
    },
    db,
  );
