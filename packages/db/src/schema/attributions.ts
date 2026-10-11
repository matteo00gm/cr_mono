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
 *
 * **A ledger of two kinds of entry** (P6-08). A sale, and a refund of one: the
 * same line, the refund line's id, and a negative quantity and amount. What a
 * line is worth is the sum of its entries, which is how a refund reduces a
 * number nobody is allowed to rewrite.
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

    /** Units sold; negative on a refund, for the units it took back. */
    quantity: integer('quantity').notNull(),

    /**
     * What the shopper paid for the line after its discounts, in hundredths of
     * `currency`; negative on a refund, for what it took back.
     */
    amountCents: integer('amount_cents').notNull(),
    currency: text('currency').notNull(),

    /**
     * Shopify's id for the refund's line, on a refund; null on a sale. It is
     * what makes a redelivered `refunds/create` take the amount off once.
     */
    refundLineId: text('refund_line_id'),

    /**
     * When the order was placed, as Shopify says — not when we heard of it. A
     * refund carries its sale's, so it reduces the day the sale was counted on.
     */
    orderedAt: timestamp('ordered_at', { withTimezone: true, mode: 'date' }).notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** A sale, once per order line. */
    uniqueIndex('attributions_tenant_order_line_key')
      .on(table.tenantId, table.orderId, table.lineItemId)
      .where(sql`${table.refundLineId} IS NULL`),
    /** A refund line, once ever. */
    uniqueIndex('attributions_tenant_refund_line_key')
      .on(table.tenantId, table.refundLineId)
      .where(sql`${table.refundLineId} IS NOT NULL`),
    /** "What did the sommelier sell, for this winery, over this window" (§2.4). */
    index('attributions_tenant_ordered_idx').on(table.tenantId, table.orderedAt.desc()),
    /** The sign of an entry is its kind: a sale cannot be negative, nor a refund positive. */
    check(
      'attributions_sign_matches_kind',
      sql`(refund_line_id IS NULL AND quantity > 0 AND amount_cents >= 0) OR (refund_line_id IS NOT NULL AND quantity < 0 AND amount_cents <= 0)`,
    ),
    check('attributions_currency_format', sql`currency ~ '^[A-Z]{3}$'`),
  ],
);
