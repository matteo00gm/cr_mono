import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import { getCurrentTenantId, type DbTransaction } from './with-tenant.js';

/**
 * The widget's resolution scope (P2-07).
 *
 * **The fifth RLS context, and the only one that cannot write.** The widget
 * surface has to answer "which tenant is this?" from `(pk_, Origin)` before any
 * tenant is known — that question is what resolution *is* — and every table it
 * needs (`widget_keys`, `tenant_domains`, `tenants`) is under a forced
 * `tenant_isolation` policy. The row's own plan, an un-scoped connection, does
 * not work: as `app_rw` a query with no context returns nothing, and the only
 * way around that is a role that bypasses RLS on the request path.
 *
 * So it follows `withInvitation` (P0-51) and `withOutbox` (P1-31): two
 * transaction-local GUCs, and migration `0042` gives each of the three tables a
 * `tenant_isolation` policy with a branch that admits them. ADR 0022 records
 * the decision and what it costs.
 *
 * **What it admits, and the order it narrows in.** The key row whose
 * `public_key` is the key; the domain row whose `origin` is the origin *and*
 * whose tenant is that key's tenant; and the tenant row only when that domain is
 * `VERIFIED`. A key alone never reaches a tenant row, and an origin alone reaches
 * nothing at all.
 *
 * **What makes it safe to hold, rather than merely narrow: it is read-only.**
 * The transaction opens `READ ONLY`, so an `INSERT`, `UPDATE` or `DELETE` inside
 * it fails at the database whatever the policies say. That closes the gap ADR
 * 0021 had to close with a grant revoke — a `DELETE` is filtered by `USING`
 * alone, so under an admitting branch it would match the admitted rows — and it
 * closes it for every table at once, including `tenant_domains`, where DELETE
 * is a real operation and could not be revoked.
 *
 * `WITH CHECK` stays tenant-only on all three tables as well, so even without
 * the read-only transaction this context could not write a row naming a tenant.
 * Two bounds, each sufficient, because the thing being bounded is the path an
 * unauthenticated visitor's browser drives.
 */

export const WIDGET_KEY_GUC = 'app.widget_key';
export const WIDGET_ORIGIN_GUC = 'app.widget_origin';

export class InvalidWidgetScopeError extends Error {
  constructor() {
    super(
      'A widget scope needs both a public key and a normalised origin. An empty one ' +
        'matches no row, and would come back looking exactly like an unknown key.',
    );
    this.name = 'InvalidWidgetScopeError';
  }
}

/**
 * Rejected rather than merged, for `withUser`'s reason with a sharper edge.
 *
 * With `app.tenant_id` set too, each policy's tenant branch and widget branch
 * are OR-ed — so a read that looked tenant-scoped would also see another
 * tenant's key, domain and tenant row the moment a widget GUC was set beside
 * it.
 */
export class NestedWidgetContextError extends Error {
  constructor(tenantId: string) {
    super(
      `Cannot open a widget scope inside withTenant("${tenantId}"). With both set, each ` +
        "policy's tenant and widget branches are OR-ed, so a tenant-scoped read could see " +
        "another tenant's key, domain and tenant row.",
    );
    this.name = 'NestedWidgetContextError';
  }
}

/**
 * Runs `fn` in a read-only transaction that can see one key, its matching
 * domain and — when that domain is verified — its tenant.
 *
 * Both values are transaction-local (`set_config`'s third argument), for the
 * reason every context here gives: without it they outlive the transaction on
 * a pooled connection and the next request inherits them.
 */
export const withWidgetKey = async <T>(
  publicKey: string,
  origin: string,
  fn: (tx: DbTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> => {
  if (publicKey.trim() === '' || origin.trim() === '') throw new InvalidWidgetScopeError();

  const activeTenant = getCurrentTenantId();
  if (activeTenant !== undefined) throw new NestedWidgetContextError(activeTenant);

  return db.transaction(
    async (tx) => {
      await tx.execute(
        sql`SELECT set_config(${WIDGET_KEY_GUC}, ${publicKey}, true), set_config(${WIDGET_ORIGIN_GUC}, ${origin}, true)`,
      );

      return fn(tx);
    },
    { accessMode: 'read only' },
  );
};
