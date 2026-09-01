import { sql } from 'drizzle-orm';
import { check, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `widget_keys` — the public and secret keys a tenant integrates with (P0-25).
 *
 * `pk_` is public by construction: it ships in a script tag on the seller's own
 * page, and everything that protects it is the origin allowlist (§3.2) rather
 * than the key being hard to read. `sk_` is the opposite — it authenticates a
 * server-to-server session mint (§3.4, option 3) and must never be recoverable
 * from this table, not by a query, not from a backup, not by whoever reads the
 * replica.
 */
export const widgetKeys = pgTable(
  'widget_keys',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** Plaintext, because it is public. Unique so a key identifies one tenant. */
    publicKey: text('public_key').notNull().unique(),

    /**
     * argon2id. There is no plaintext column for the secret anywhere in this
     * table, and that is the property the tests assert directly rather than by
     * reading the schema.
     */
    secretKeyHash: text('secret_key_hash').notNull(),

    /**
     * Enough to recognise a key in the dashboard, not enough to use it: the
     * `sk_live_` style prefix and the last four characters. Without these the UI
     * has to either show nothing — leaving "which of my keys is this?"
     * unanswerable — or store something it should not.
     */
    secretKeyPrefix: text('secret_key_prefix').notNull(),
    secretKeyLast4: text('secret_key_last4').notNull(),

    /**
     * When this key stopped being the active one. Not "when it stops working" —
     * see `grace_until`.
     */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),

    /**
     * The 24-hour window in which a revoked public key is still accepted (P4-08).
     *
     * Rotation cannot be atomic: the seller's page carries the old key until
     * they redeploy. So rotation sets `revoked_at` on the old row — it is no
     * longer *the* key — while `grace_until` keeps it working for a day. The two
     * columns answer different questions, and collapsing them into one would
     * force a choice between breaking every page instantly and never expiring
     * anything.
     */
    graceUntil: timestamp('grace_until', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * One active public key per tenant.
     *
     * Partial, on `revoked_at IS NULL`, so rotation works: the old row is
     * revoked in the same transaction that inserts the new one, and a tenant is
     * never in a state where two keys are simultaneously "the" key. A plain
     * unique on `tenant_id` would make rotation impossible; no constraint at all
     * would let a bug leave two live keys and make "which tenant is this
     * request for" depend on row order.
     */
    uniqueIndex('widget_keys_one_active_per_tenant')
      .on(table.tenantId)
      .where(sql`revoked_at is null`),

    /**
     * `grace_until` is meaningless on a key that was never revoked, and a grace
     * window on a live key is the shape of a bug that keeps a compromised key
     * alive. Tie them together here rather than trusting the rotation code.
     */
    check(
      'widget_keys_grace_requires_revocation',
      sql`grace_until is null or revoked_at is not null`,
    ),

    /** Four characters, because that is what "last4" means. */
    check('widget_keys_last4_length', sql`char_length(secret_key_last4) = 4`),
  ],
);
