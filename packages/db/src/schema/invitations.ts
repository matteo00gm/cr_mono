import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `invitations` — pending offers of membership (P0-51).
 *
 * Two wineries are useless without a way to add the second person, and the
 * decision recorded in the row is that we own this rather than syncing it from
 * an external organisation service: `memberships` is the authorization
 * boundary, read on every request under RLS, and a webhook-synchronised copy of
 * it would make authorization decisions against stale data on every delayed or
 * dropped delivery — silently.
 *
 * The row is a **capability**, not a record of intent. Whoever holds the token
 * can become a member of this tenant with this role, which is why the token is
 * stored hashed and why `role` lives here rather than being read back from the
 * acceptance request.
 */
export const invitations = pgTable(
  'invitations',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * Normalised — lowercased and trimmed — by the application before it is
     * written, so the uniqueness below compares what a human would compare.
     */
    email: text('email').notNull(),

    /**
     * The role the invitee gets **when they accept**.
     *
     * Here rather than in the acceptance request, and this is the point of the
     * column: the acceptance payload is controlled by the invitee, so a role
     * read from it is a privilege-escalation endpoint with extra steps. The
     * inviter chose `EDITOR`; nothing the invitee sends can change that.
     */
    role: text('role').notNull(),

    /**
     * SHA-256 of the token, hex.
     *
     * Hashed for the same reason `widget_keys.secret_key_hash` is: a dump of
     * this table must not hand the reader membership of every tenant with an
     * open invitation. **SHA-256 rather than argon2id**, and the difference from
     * `widget_keys` is deliberate — the token is 256 bits from a CSPRNG, so
     * there is no dictionary to attack and no weak input to stretch. A slow KDF
     * would buy nothing and put a deliberate delay on the acceptance path.
     */
    tokenHash: text('token_hash').notNull(),

    /** Who sent it. Kept for the audit trail and for the email's "from". */
    invitedBy: text('invited_by').notNull(),

    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),

    /**
     * Set once, when the invitation is redeemed. **This is what makes the token
     * single-use** — the acceptance path takes `FOR UPDATE` on the row and
     * refuses one that is already stamped, so two acceptances of the same token
     * cannot both create a membership.
     */
    acceptedAt: timestamp('accepted_at', { withTimezone: true, mode: 'date' }),

    /** Set when an OWNER withdraws an invitation before it is accepted. */
    revokedAt: timestamp('revoked_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The lookup the acceptance path makes, and the only one it makes.
     *
     * Unique across tenants rather than within one: the hash is the credential,
     * and a collision would mean two invitations answering to the same secret.
     */
    uniqueIndex('invitations_token_hash_idx').on(table.tokenHash),

    /**
     * One *open* invitation per address per tenant.
     *
     * Partial, on the rows that are still open. That is what makes re-inviting
     * an existing invitee a no-op rather than a duplicate, without preventing a
     * second invitation after the first expired or was revoked — which is a
     * legitimate thing an owner does when somebody says "it stopped working".
     */
    uniqueIndex('invitations_open_per_email_idx')
      .on(table.tenantId, table.email)
      .where(sql`accepted_at is null and revoked_at is null`),

    index('invitations_tenant_idx').on(table.tenantId),

    /**
     * The role vocabulary, enforced by the database.
     *
     * A CHECK rather than an enum, following P0-31: adding a role stays a
     * migration either way, but an enum also leaves a type behind when the
     * table is dropped, which the reversibility suite would then catch as
     * residue.
     */
    check('invitations_role_check', sql`role in ('OWNER', 'EDITOR')`),
  ],
);
