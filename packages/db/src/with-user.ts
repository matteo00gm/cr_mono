import { sql } from 'drizzle-orm';
import { type Database, getDb } from './client.js';
import { type DbTransaction, getCurrentTenantId } from './with-tenant.js';

/**
 * The user-scoped read, for tenant resolution (P0-47).
 *
 * Tenant resolution has a chicken-and-egg problem: it must read `memberships`
 * to find out which tenant the caller belongs to, and `withTenant` needs that
 * answer before it can run. The obvious ways out are both bad — an un-scoped
 * connection (a second hole beside the Better Auth one, and a much wider one,
 * since `memberships` is the table authorisation is built on), or a `SECURITY
 * DEFINER` function (the same thing wearing a hat).
 *
 * **Neither is necessary, because P0-37 already designed for this.** The
 * `memberships` policy is deliberately not the boilerplate:
 *
 * ```sql
 * USING      (tenant_id = app.tenant_id OR user_id = app.user_id)
 * WITH CHECK (tenant_id = app.tenant_id)
 * ```
 *
 * Setting `app.user_id` alone therefore admits **exactly the caller's own
 * membership rows and nothing else** — not another user's, not another
 * tenant's, and nothing in any other table, since no other policy reads that
 * GUC. The query stays under RLS the whole way, which is a far stronger
 * guarantee than "we were careful with the WHERE clause".
 *
 * Note what `WITH CHECK` does *not* include: `user_id`. Writing is still
 * tenant-scoped, so this context can read a membership but can never create
 * one — otherwise any authenticated user could insert themselves into any
 * tenant, which is the whole authorisation model gone.
 */

/**
 * Better Auth ids are opaque text, not UUIDs (P0-23a), so the only check worth
 * making is that the value is present and not something that would silently
 * become an empty GUC — `nullif(current_setting(...), '')` treats empty as
 * absent, and an empty `app.user_id` would match no row rather than every row,
 * but failing loudly beats returning a confusing zero.
 */
export class InvalidUserIdError extends Error {
  constructor(invalidId: string) {
    super(`Invalid user ID "${invalidId}". A user ID must be a non-empty string.`);
    this.name = 'InvalidUserIdError';
  }
}

/**
 * Rejected rather than merged, because the combination widens the policy.
 *
 * With both GUCs set, `memberships` matches `tenant_id = … OR user_id = …` —
 * so a read that looks tenant-scoped would also return that user's rows in
 * *other* tenants. Nothing needs that, and an accidental nesting is far more
 * likely to be a bug than an intention.
 */
export class NestedUserContextError extends Error {
  constructor(tenantId: string) {
    super(
      `Cannot open a user context inside withTenant("${tenantId}"). ` +
        'With both GUCs set the memberships policy matches on either, so a ' +
        'tenant-scoped read would also return rows from other tenants.',
    );
    this.name = 'NestedUserContextError';
  }
}

/**
 * Runs `fn` with `app.user_id` set, transaction-locally.
 *
 * `true` as the third argument to `set_config` makes it `SET LOCAL`, so the
 * value dies with the transaction and cannot leak onto the next request that
 * borrows the pooled connection — the same rule, and the same reason, as
 * `withTenant`.
 */
export const withUser = async <T>(
  userId: string,
  fn: (tx: DbTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> => {
  if (!userId || userId.trim() === '') {
    throw new InvalidUserIdError(userId);
  }

  const activeTenant = getCurrentTenantId();
  if (activeTenant !== undefined) {
    throw new NestedUserContextError(activeTenant);
  }

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config('app.user_id', ${userId}, true)`);
    return fn(tx);
  });
};
