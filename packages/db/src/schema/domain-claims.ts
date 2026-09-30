import { sql } from 'drizzle-orm';
import {
  check,
  index,
  pgEnum,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `domain_claims` — a winery proving it now controls an origin another winery
 * holds (P4-18, ADR 0028).
 *
 * `UNIQUE(origin)` on `tenant_domains` is the anti-sharing backbone (§3.2), and
 * it makes ordinary business events into dead ends: a winery churns and
 * abandons its account, the business is sold, an agency rebuilds the site under
 * a new workspace. This table is the way through that does not involve us
 * running SQL by hand.
 *
 * - `PENDING` — created, waiting for the claimant's `_somm-verify` TXT record.
 * - `PROVEN` — the record was there. Settled at once, into one of the two below.
 * - `NOTICE` — the holder is paying, so it has 72 hours to answer first.
 * - `TRANSFERRED` — the origin moved.
 * - `CANCELED` — the holder withdrew it, which is the one thing a holder writes.
 */
export const domainClaimStatus = pgEnum('domain_claim_status', [
  'PENDING',
  'PROVEN',
  'NOTICE',
  'TRANSFERRED',
  'CANCELED',
]);

const ORIGIN_FORMAT =
  "origin ~ '^https?://[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$'";

export const domainClaims = pgTable(
  'domain_claims',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /** The claimant. The claim is theirs: they made it and they hold its nonce. */
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * The holder a proven claim put on notice. Null until then, and set only
     * with the notice — which is the moment the holder needs to see the claim,
     * and not a moment before. Never returned to the claimant.
     */
    incumbentTenantId: uuid('incumbent_tenant_id').references(() => tenants.id, {
      onDelete: 'set null',
    }),

    /** The serialised origin, as `tenant_domains` would store it. */
    origin: text('origin').notNull(),
    registrableDomain: text('registrable_domain').notNull(),

    status: domainClaimStatus('status').notNull().default('PENDING'),

    /** The claimant's own nonce, never the holder's. Single use, cleared on proof. */
    verificationToken: text('verification_token'),
    verificationExpiresAt: timestamp('verification_expires_at', {
      withTimezone: true,
      mode: 'date',
    }),

    provenAt: timestamp('proven_at', { withTimezone: true, mode: 'date' }),
    /** When a paying holder's notice runs out. */
    transferAt: timestamp('transfer_at', { withTimezone: true, mode: 'date' }),
    settledAt: timestamp('settled_at', { withTimezone: true, mode: 'date' }),

    /**
     * Which state both wineries have been told about, and when (P4-18b). A
     * notice's clock starts at `notified_at`, and the policy will not settle a
     * notice without one: a holder nobody told cannot lose its origin.
     */
    notifiedStatus: domainClaimStatus('notified_status'),
    notifiedAt: timestamp('notified_at', { withTimezone: true, mode: 'date' }),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    check('domain_claims_origin_format', sql.raw(ORIGIN_FORMAT)),
    check(
      'domain_claims_notice_complete',
      sql`status <> 'NOTICE' OR (incumbent_tenant_id IS NOT NULL AND transfer_at IS NOT NULL)`,
    ),
    /** One open claim per winery per origin; a settled one does not block the next. */
    uniqueIndex('domain_claims_open_unique')
      .on(table.tenantId, table.origin)
      .where(sql`status IN ('PENDING', 'PROVEN', 'NOTICE')`),
    index('domain_claims_incumbent_idx')
      .on(table.incumbentTenantId)
      .where(sql`incumbent_tenant_id IS NOT NULL`),
    index('domain_claims_unnotified_idx')
      .on(table.status)
      .where(sql`notified_status IS DISTINCT FROM status`),
    index('domain_claims_due_idx')
      .on(table.transferAt)
      .where(sql`status = 'NOTICE'`),
  ],
);
