import { sql } from 'drizzle-orm';

import { asDate } from './timestamps.js';
import { withTenant, type DbTransaction } from './with-tenant.js';
import type { Database } from './client.js';

/**
 * Ending the sessions a removed domain left behind (P4-06, §3.3).
 *
 * **Why a timestamp and not a revocation list.** `token_revocations` names one
 * `jti` each, and we never store the `jti`s we issue — so "revoke every live
 * session on this origin" cannot be done by listing them. One row per origin
 * does it, and stays one row however many sessions were open.
 */

/**
 * Ends every session on an origin, from now.
 *
 * Takes the caller's transaction, because the cutoff and the removal it belongs
 * to have to be one write: a removal that committed without its cutoff would
 * leave live sessions on an origin nobody can see any more.
 *
 * `ON CONFLICT` moves the cutoff forward rather than adding a row — a seller
 * who removes an origin, re-verifies it and removes it again has ended two sets
 * of sessions, and only the later cutoff is the one that matters.
 */
export const endSessionsFor = async (tx: DbTransaction, origin: string): Promise<void> => {
  await tx.execute(sql`
    INSERT INTO widget_session_cutoffs (tenant_id, origin, valid_from)
    VALUES (
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${origin},
      now()
    )
    ON CONFLICT (tenant_id, origin) DO UPDATE SET valid_from = now()
  `);
};

/**
 * When sessions on this origin became invalid, or nothing.
 *
 * Opens its own `withTenant` because it runs on the widget request path, where
 * the tenant is known — CORS resolved it from `(pk_, Origin)` two checks
 * earlier — and there is no caller transaction to join. Exactly the shape
 * `isTokenRevoked` has, for exactly the same reason.
 */
export const sessionCutoffAt = (
  tenantId: string,
  origin: string,
  db?: Database,
): Promise<Date | undefined> =>
  withTenant(
    tenantId,
    async (tx) => {
      const rows = await tx.execute(sql`
        SELECT valid_from FROM widget_session_cutoffs WHERE origin = ${origin} LIMIT 1
      `);

      const row = [...rows][0] as { valid_from?: string | Date } | undefined;

      return row?.valid_from === undefined ? undefined : asDate(row.valid_from);
    },
    db,
  );
