import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import { conversations } from './conversations.js';
import { products } from './products.js';
import { tenants } from './tenants.js';

/**
 * `attributions` — the wines the sommelier sold (P6-07, §2.4).
 *
 * One row per **line item** of a Shopify order that carried the visit the
 * widget planted on it (P3-11). Never one per order: only the wines we
 * recommended count, and a number that credits the whole basket is a number a
 * seller eventually stops believing.
 *
 * **Keyed by the order's line, so a redelivered webhook counts once.** Shopify
 * redelivers, and the unique index is what makes the second delivery a no-op
 * rather than a second sale.
 *
 * **Nothing about the buyer is here.** An order's body carries a name, an
 * address, an email; this table holds ids, a quantity and an amount, and the
 * parser that feeds it (`readOrder`) reads nothing else.
 *
 * **Written once.** `app_rw` may insert and delete — a shop's data goes when
 * Shopify says it must (`shop/redact`) — and may not update: an amount a seller
 * was shown should not be one a later bug can quietly rewrite.
 */
export const attributions = pgTable(
  'attributions',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /** The store that reported the order: its `*.myshopify.com` name. */
    shop: text('shop').notNull(),

    /** Shopify's id for the order, and for the line within it. Text: they are not ours to do arithmetic on. */
    orderId: text('order_id').notNull(),
    lineItemId: text('line_item_id').notNull(),

    /**
     * The visit: the anonymous per-tab id the line carried as `_somm_session`,
     * which is also what `widget_events.session_id` holds (P6-01). It survives
     * the conversation, as it does there.
     */
    sessionId: text('session_id').notNull(),

    /**
     * `set null`, for `widget_events`' reason: when a conversation is purged
     * for retention (P7-07) the sale it led to still happened.
     */
    conversationId: uuid('conversation_id').references(() => conversations.id, {
      onDelete: 'set null',
    }),

    /** Which of the winery's wines the line was, when its variant is one we know. */
    productId: uuid('product_id').references(() => products.id, { onDelete: 'set null' }),

    quantity: integer('quantity').notNull(),

    /** What the shopper paid for the line after its discounts, in hundredths of `currency`. */
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),

    /** When the order was placed, as Shopify says — not when we heard of it. */
    orderedAt: timestamp('ordered_at', { withTimezone: true, mode: 'date' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('attributions_tenant_order_line_key').on(
      table.tenantId,
      table.orderId,
      table.lineItemId,
    ),
    /** "What did the sommelier sell, for this winery, over this window" (§2.4). */
    index('attributions_tenant_ordered_idx').on(table.tenantId, table.orderedAt.desc()),
    check('attributions_quantity_positive', sql`quantity > 0`),
    check('attributions_amount_not_negative', sql`amount_cents >= 0`),
    check('attributions_currency_format', sql`currency ~ '^[A-Z]{3}$'`),
  ],
);
