import { jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * One import attempt, keyed so a repeat applies once (P1-26).
 *
 * **What a replay would cost without it is not rows but work and records.**
 * An import is an upsert by SKU, so running one twice leaves the catalogue the
 * same — but it re-queues every changed wine's embedding and, from P1-28,
 * writes a second audit entry for an import the seller made once. A
 * double-clicked confirm and a client retry after a dropped connection are
 * both ordinary, so the guard is a row rather than a hope.
 */
export const importRuns = pgTable(
  'import_runs',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * The client's UUID for this attempt, from the `Idempotency-Key` header.
     *
     * Unique **per tenant** rather than globally: a key is the client's choice,
     * and one winery's key colliding with another's must not refuse either — or
     * tell the second that the first exists.
     */
    idempotencyKey: text('idempotency_key').notNull(),

    /**
     * SHA-256 of the validated rows, hex.
     *
     * The same key with a different body is a client bug, and answering it
     * with the stored result of the *first* body would report an import that
     * never happened. The hash is what lets it be refused instead.
     */
    requestHash: text('request_hash').notNull(),

    /** The response the first attempt returned, replayed verbatim. `null` while it runs. */
    result: jsonb('result'),

    claimedAt: timestamp('claimed_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
    completedAt: timestamp('completed_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [unique('import_runs_tenant_key_unique').on(table.tenantId, table.idempotencyKey)],
);
