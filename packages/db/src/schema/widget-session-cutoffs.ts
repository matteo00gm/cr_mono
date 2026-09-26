import { pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `widget_session_cutoffs` — the sessions a removed domain left behind (P4-06).
 *
 * **Not a revocation list.** `token_revocations` names one `jti` each, and we do
 * not store the `jti`s we issue — so revoking every live session on an origin by
 * listing them is impossible by construction. A timestamp does it in one row,
 * and it stays one row however many sessions were open.
 *
 * Its own table rather than a column on `tenant_domains`, because the domain row
 * is *deleted* when a seller removes it. A soft delete is not the alternative:
 * the unique index on `origin` is the anti-sharing backbone (§3.2), and a
 * tombstone would hold an origin against every other winery for ever.
 */
export const widgetSessionCutoffs = pgTable(
  'widget_session_cutoffs',
  {
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** The serialised origin, as `tenant_domains` stored it. */
    origin: text('origin').notNull(),

    /**
     * A session whose **first** token was minted before this is over.
     *
     * Compared against the `iat_original` claim, never against `iat`: the
     * current token's own issue time moves every time a session refreshes
     * (P3-21), so comparing it would let a session outlive its revocation by
     * doing the one thing a live session does anyway.
     */
    validFrom: timestamp('valid_from', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One cutoff per origin, and re-removing an origin moves it forward rather
     * than adding a row — so this table's size is bounded by how many origins a
     * winery has ever held, not by how often they change their mind.
     */
    primaryKey({ columns: [table.tenantId, table.origin] }),
  ],
);
