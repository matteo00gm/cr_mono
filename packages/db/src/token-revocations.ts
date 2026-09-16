import { sql } from 'drizzle-orm';

import type { Database } from './client.js';
import { PRUNE_BATCH } from './rate-limit.js';
import { REVOCATION_SWEEP_GRACE_SEC } from './revocation-grace.js';
import { withLapsedRevocations } from './with-lapsed-revocations.js';
import { withTenant } from './with-tenant.js';

/**
 * Whether a widget token has been revoked (P2-12a, and P2-13 after it).
 *
 * **Asked under the tenant this request resolved**, not the one the token names.
 * A caller compares the token's `tid` with that tenant before asking, so a token
 * for another tenant never gets this far — and if one did, the policy would
 * answer for the resolved tenant alone.
 *
 * **Any row counts, including one past `expires_at`.** The row's expiry is when
 * the token would have lapsed, and a session may be continued with a token for
 * half an hour after that. So an expired row still refuses until P2-14's sweep
 * removes it, and the sweep has to leave it for the continuation window.
 */
export const isTokenRevoked = (tenantId: string, jti: string, db?: Database): Promise<boolean> =>
  withTenant(
    tenantId,
    async (tx) => {
      const rows = await tx.execute(sql`
        SELECT 1 FROM token_revocations WHERE jti = ${jti} LIMIT 1
      `);

      return [...rows].length > 0;
    },
    db,
  );

/**
 * Deletes a batch of revocations that no longer refuse anything (P2-14).
 *
 * The statement names the rows it wants, and the policy it runs under admits no
 * others: `withLapsedRevocations` reaches a revocation only once its token lapsed
 * more than `REVOCATION_SWEEP_GRACE_SEC` ago. The policy is the guarantee; the
 * `WHERE` is what makes a batch pick the oldest rows first.
 */
export const pruneLapsedRevocations = (
  limit: number = PRUNE_BATCH,
  db?: Database,
): Promise<number> =>
  withLapsedRevocations(async (tx) => {
    const rows = await tx.execute(sql`
      DELETE FROM token_revocations
      WHERE jti IN (
        SELECT jti FROM token_revocations
        WHERE expires_at < now() - make_interval(secs => ${REVOCATION_SWEEP_GRACE_SEC})
        ORDER BY expires_at
        LIMIT ${limit}
      )
      RETURNING 1
    `);

    return [...rows].length;
  }, db);
