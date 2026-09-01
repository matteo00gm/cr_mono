import { index, jsonb, pgEnum, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { conversations } from './conversations.js';
import { products } from './products.js';
import { tenants } from './tenants.js';

/**
 * `widget_events` — the funnel log (P0-29).
 *
 * Feeds every analytics panel in §2.4, including the `ZERO_RESULTS` insight
 * that tells a seller their catalog is too thin for the questions people are
 * actually asking — which is the panel that pays for this table.
 *
 * **This is the first table that will need partitioning.** It grows with visitor
 * activity rather than with catalog size, so it outruns everything else by an
 * order of magnitude: one conversation produces a dozen rows here and two in
 * `messages`. Revisit at P7 with measured numbers — monthly range partitions on
 * `created_at`, or a nightly rollup into a daily aggregate plus a prune. Do not
 * pre-emptively partition now; at two tenants it would be complexity buying
 * nothing.
 */
export const widgetEventType = pgEnum('widget_event_type', [
  'WIDGET_OPEN',
  'MESSAGE_SENT',
  'RECOMMENDATION_SHOWN',
  'PRODUCT_DETAIL_VIEW',
  'ADD_TO_CART',
  'CART_OPEN',
  'ZERO_RESULTS',
]);

export const widgetEvents = pgTable(
  'widget_events',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * Nullable, and `set null` rather than `cascade`.
     *
     * A `WIDGET_OPEN` happens before any conversation exists, so the column has
     * to allow null. And when a conversation is purged for retention (P7-07) the
     * funnel counts must not go with it — analytics that silently shrink as old
     * data ages out are analytics nobody can reason about.
     */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),

    /** Survives the conversation, so a funnel can still be reconstructed. */
    sessionId: text('session_id').notNull(),

    type: widgetEventType('type').notNull(),

    /**
     * Which product the event is about, where that makes sense. `set null` for
     * the same reason: an archived product must not erase the add-to-cart events
     * it earned, or every historical conversion rate changes retroactively.
     */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),

    /**
     * Event-shaped extras — the query behind a `ZERO_RESULTS`, the cart adapter
     * for an `ADD_TO_CART`. `jsonb`, not `json`: it is queried, and `json` keeps
     * the raw text without an index worth having.
     */
    metadata: jsonb('metadata'),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /**
     * Every §2.4 panel asks the same question — "these events, for this tenant,
     * over this window" — so the index leads with tenant and type and orders by
     * time. `tenant_id` leading also serves the referential check behind a
     * tenant delete.
     */
    index('widget_events_tenant_type_created_idx').on(
      table.tenantId,
      table.type,
      table.createdAt.desc(),
    ),

    /** Reconstructing one visitor's funnel, which is a different question. */
    index('widget_events_session_idx').on(table.sessionId, table.createdAt),
  ],
);
