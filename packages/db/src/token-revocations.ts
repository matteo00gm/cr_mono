import { sql } from 'drizzle-orm';

import type { Database } from './client.js';
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
