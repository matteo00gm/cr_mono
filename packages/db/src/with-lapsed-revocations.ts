import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The revocation sweep's scope (P2-14) — the **sixth** RLS context, and ADR 0023.
 *
 * **It widens, like `withOutbox`.** The sweep deletes every tenant's lapsed
 * revocations in one statement, and there is no tenant to scope that to:
 * learning which tenants have lapsed revocations is itself the cross-tenant read.
 *
 * **What bounds it is in the policy, not here.** The flag's branch carries its
 * own row predicate: a revocation is admitted only once its token lapsed more
 * than `REVOCATION_SWEEP_GRACE_SEC` ago. So a revocation that could still refuse
 * a token is invisible to this scope whatever runs inside it, and `WITH CHECK`
 * stays tenant-only, so nothing here can write or move one.
 *
 * Named for what it unlocks, as `withOutbox` is. The value is transaction-local,
 * like every other context, so a pooled connection never carries it into the
 * next request.
 */
export const REVOCATION_SWEEPER_GUC = 'app.revocation_sweeper';

/** Runs `fn` in a transaction that can see, and delete, every tenant's lapsed revocations. */
export const withLapsedRevocations = async <T>(
  fn: (tx: DbTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`SELECT set_config(${REVOCATION_SWEEPER_GUC}, 'on', true)`);

    return fn(tx);
  });
