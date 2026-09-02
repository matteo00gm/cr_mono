import { index, inet, jsonb, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `audit_log` — who did what (P0-31).
 *
 * Now that two roles can act on a tenant (§2.7), "who removed that domain?"
 * needs an answer, and it needs one before there is a screen to read it on —
 * §4.2 defers the browsable view, not the record. Until then it is a direct
 * query and a runbook.
 *
 * Append-only, enforced by `0017_audit_log_append_only.sql`. That migration is
 * not a formality: P0-21's default privileges grant `app_rw` all four DML verbs
 * on every table `app_migrate` creates, so without the revoke this table
 * arrives fully rewritable. An audit log the application can edit records
 * whatever the application last believed, which is not what an audit log is
 * for.
 */
export const auditLog = pgTable(
  'audit_log',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * `text`, not `uuid`, for the same reason as `memberships.user_id`: Better
     * Auth ids are not UUIDs (P0-23). The FK arrives with P0-23a.
     *
     * Nullable, because not every audited action has a human behind it. A
     * subscription downgrade applied by the Stripe webhook (P5-09) changes what
     * a tenant can do and belongs in this log, and attributing it to a person
     * would be a lie.
     */
    actorUserId: text('actor_user_id'),

    /**
     * What happened and to what, as free text rather than enums.
     *
     * An audit log has to be able to record an action added next week without a
     * migration — a schema change on the write path is exactly the friction
     * that makes people log nothing. Readers of this column are a runbook and a
     * human, not a query planner.
     */
    action: text('action').notNull(),
    target: text('target'),

    /** Action-shaped detail: the old and new value, the domain removed. */
    metadata: jsonb('metadata'),

    /**
     * `inet`, not `text`. The type rejects a malformed address at write time
     * and makes subnet containment queries possible when someone eventually
     * asks "what else came from that network".
     */
    ip: inet('ip'),

    userAgent: text('user_agent'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * The only question anyone asks of this table until P4 builds a screen:
     * what happened in this tenant, most recent first.
     */
    index('audit_log_tenant_created_idx').on(table.tenantId, table.createdAt.desc()),
  ],
);
