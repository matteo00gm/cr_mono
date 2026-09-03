import { index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `token_revocations` — the revoked `jti` list for widget session tokens
 * (P0-35).
 *
 * Widget tokens live 15 minutes, which is short enough that expiry does most of
 * the work and not short enough to be the whole answer: removing a domain
 * (P4-06) has to stop the tokens already issued to it *now*, not in a quarter
 * of an hour. This table is what makes revocation immediate.
 *
 * It stays small on purpose. Every row becomes meaningless once `expires_at`
 * passes — a token that has expired cannot be replayed whether or not it is
 * listed here — so P2-14's sweep deletes them, and unlike the P0-30 to P0-32
 * ledgers that deletion is the design rather than a hole in it.
 */
export const tokenRevocations = pgTable(
  'token_revocations',
  {
    /**
     * The JWT id, as minted. Text rather than uuid: the `jti` is whatever the
     * minting code (P2-11) puts there, and pinning a format here would be a
     * constraint on a value this table only ever compares for equality.
     */
    jti: text('jti').primaryKey(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * When the token would have expired anyway. Not null, because a row with no
     * expiry could never be swept and this table's whole size argument rests on
     * every row eventually becoming deletable.
     */
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The sweep (P2-14) scans by expiry, not by jti, so the primary key does
     * not serve it. Without this the sweep degrades as the table grows —
     * which is precisely when it matters that the sweep is cheap.
     */
    index('token_revocations_expires_at_idx').on(table.expiresAt),
  ],
);
