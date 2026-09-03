import { sql } from 'drizzle-orm';
import {
  bigserial,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';

import { tenants } from './tenants.js';

/**
 * `outbox` — the transactional outbox for embedding jobs (P0-36).
 *
 * A product committed without a queued embedding job is invisible to search,
 * and the visitor sees a catalog that silently lacks it. Writing this row **in
 * the same transaction** as the product is what makes that impossible (§4.1):
 * either both land or neither does. A queue publish after commit cannot offer
 * that — the process can die in the gap, and nothing afterwards knows a job is
 * missing.
 */
export const outbox = pgTable(
  'outbox',
  {
    /**
     * `bigserial`, not a uuid. The poller (P1-31) reads in insertion order, and
     * a monotonic key gives it that for free; random uuids would need a
     * separate ordering column doing the same job.
     */
    id: bigserial('id', { mode: 'number' }).primaryKey(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** What the event is about — a product id today. */
    aggregateId: uuid('aggregate_id').notNull(),

    eventType: text('event_type').notNull(),

    payload: jsonb('payload'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),

    /** Null until the poller has published it. The queue of work is the nulls. */
    processedAt: timestamp('processed_at', { withTimezone: true, mode: 'date' }),

    attempts: integer('attempts').notNull().default(0),
  },
  (table) => [
    /**
     * Partial, `where processed_at is null`, and that is the whole point.
     *
     * The poller asks one question — what is unprocessed — and the answer is a
     * shrinking set inside a table that only grows. A full index over
     * `processed_at` would keep every published row in it and degrade steadily
     * as the table fills, which is the kind of decay nobody notices until the
     * poller is the slowest thing in the system.
     */
    index('outbox_unprocessed_idx')
      .on(table.createdAt)
      .where(sql`processed_at is null`),
  ],
);
