import { index, inet, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `security_events` — the log of security-relevant rejections (P0-32).
 *
 * `UNAUTHORIZED_ORIGIN` is the detection signal for widget theft (§3.2): a
 * public key being used from a site that does not own it. It surfaces as a
 * dashboard panel at P6-05, but the record has to start accumulating long
 * before there is a panel, because the question it answers is always about the
 * past.
 *
 * Append-only, for the same reason as `audit_log` — see
 * `0019_security_events_append_only.sql`.
 */
export const securityEventType = pgEnum('security_event_type', [
  'UNAUTHORIZED_ORIGIN',
  'INVALID_KEY',
  'TOKEN_ORIGIN_MISMATCH',
  'RATE_LIMITED',
  'QUOTA_EXCEEDED',
  'REPLAYED_WEBHOOK',
]);

export const securityEvents = pgTable(
  'security_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    /**
     * **Nullable, and that is the point.**
     *
     * An `INVALID_KEY` rejection has no resolvable tenant — the key did not
     * match one, which is why it was rejected. If this column were `not null`
     * the events most worth recording would be the ones that could not be
     * recorded, and the log would be silent exactly when something is wrong.
     *
     * Because of this, `security_events` is not simply tenant-scoped, and P0-37
     * cannot give it the boilerplate policy: a row with a null `tenant_id`
     * belongs to no tenant and must be readable only by `app_admin`.
     */
    tenantId: uuid('tenant_id').references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * An enum here, unlike `audit_log.action`. These six drive behaviour —
     * P2-16 counts them per key and origin to decide when a key is being
     * abused — so an unrecognised value is a bug rather than a new fact, and
     * the type is what makes it one.
     */
    type: securityEventType('type').notNull(),

    /** The Origin header as sent, kept verbatim: what was claimed matters. */
    origin: text('origin'),

    /** The `pk_` presented. Public by design, so storing it leaks nothing. */
    publicKey: text('public_key'),

    ip: inet('ip'),

    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** The P6-05 panel: these rejections, for this tenant, most recent first. */
    index('security_events_tenant_type_created_idx').on(
      table.tenantId,
      table.type,
      table.createdAt.desc(),
    ),

    /**
     * The per-pair counting in P2-16, which asks how often this key has been
     * presented from this origin. It deliberately does not lead with
     * `tenant_id`: the rows that matter most here are the ones where the tenant
     * could not be resolved at all.
     */
    index('security_events_key_origin_idx').on(table.publicKey, table.origin),
  ],
);
