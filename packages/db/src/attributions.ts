import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * Recording what the sommelier sold (P6-07): the lines of one Shopify order,
 * in one statement, under the scope's tenant.
 *
 * **A line is ours only if its visit is.** The widget plants the visit on each
 * line it adds (P3-11), but a line-item property is typed by whoever fills the
 * cart, so the value is held against `widget_events` under this scope's
 * policy: a visit this winery never had — invented, or copied from another
 * winery's page — names nothing, and the line is not recorded. Losing a sale
 * whose events never arrived is the cheaper mistake; a number that credits us
 * with sales we had no part in is the one a seller stops believing.
 *
 * **The conversation and the wine are ours to find**, never the order's to
 * say: the conversation from the visit's own events, the wine from the
 * variant id the catalogue holds (P3-11). Either may be missing — the events
 * were purged, the wine was removed — and the sale is still recorded.
 *
 * **A redelivery records nothing.** `ON CONFLICT DO NOTHING` on the line's key,
 * so the count that comes back is what this delivery added.
 */

export interface LineToAttribute {
  readonly lineItemId: string;
  /** The visit the line carried: `_somm_session`. */
  readonly sessionId: string;
  /** Shopify's numeric variant id, as the catalogue stores it, or `null`. */
  readonly variantId: string | null;
  readonly quantity: number;
  readonly amountCents: number;
}

export interface OrderToAttribute {
  /** The store that reported the order, from the installation the webhook resolved. */
  readonly shop: string;
  readonly orderId: string;
  readonly currency: string;
  /** When the order was placed; when Shopify did not say, it is recorded as now. */
  readonly orderedAt: Date | undefined;
  readonly lines: readonly LineToAttribute[];
}

/** How many lines this call attributed — none for a redelivery, or for visits that are not ours. */
export const recordAttributions = async (
  tx: DbTransaction,
  { shop, orderId, currency, orderedAt, lines }: OrderToAttribute,
): Promise<number> => {
  if (lines.length === 0) return 0;

  const rows = JSON.stringify(
    lines.map((line) => ({
      line_item_id: line.lineItemId,
      session_id: line.sessionId,
      variant_id: line.variantId,
      quantity: line.quantity,
      amount_cents: line.amountCents,
    })),
  );

  const inserted = await tx.execute(sql`
    INSERT INTO attributions (
      tenant_id, shop, order_id, line_item_id, session_id, conversation_id, product_id,
      quantity, amount_cents, currency, ordered_at
    )
    SELECT
      nullif(current_setting('app.tenant_id', true), '')::uuid,
      ${shop},
      ${orderId},
      l.line_item_id,
      l.session_id,
      (
        SELECT e.conversation_id FROM widget_events e
        WHERE e.session_id = l.session_id AND e.conversation_id IS NOT NULL
        ORDER BY e.created_at DESC
        LIMIT 1
      ),
      (
        SELECT p.id FROM products p
        WHERE p.external_variant_id = l.variant_id
        ORDER BY p.created_at
        LIMIT 1
      ),
      l.quantity,
      l.amount_cents,
      ${currency},
      coalesce(${orderedAt?.toISOString() ?? null}::timestamptz, now())
    FROM jsonb_to_recordset(${rows}::jsonb) AS l(
      line_item_id text, session_id text, variant_id text, quantity int, amount_cents int
    )
    WHERE EXISTS (SELECT 1 FROM widget_events e WHERE e.session_id = l.session_id)
    ON CONFLICT (tenant_id, order_id, line_item_id) WHERE refund_line_id IS NULL DO NOTHING
    RETURNING id
  `);

  return [...inserted].length;
};

/**
 * A refund, as Shopify reports one (P6-08): which order, and how many units of
 * which of its lines came back.
 *
 * **Ids come as candidates, not as one value.** A sale is keyed by whichever id
 * its order carried — the GraphQL id, or the number when there was none — and
 * a refund names the same order and line by number. So each is offered in
 * both spellings, and the sale is found by whichever it was written under.
 */
export interface RefundLine {
  /** Shopify's id for this line of the refund: what makes a redelivery a no-op. */
  readonly refundLineId: string;
  readonly lineItemIds: readonly string[];
  /** Units refunded. */
  readonly quantity: number;
}

export interface RefundToRecord {
  readonly orderIds: readonly string[];
  readonly lines: readonly RefundLine[];
}

/**
 * Takes a refund off what the sommelier sold — for the lines that were ours,
 * and by no more than they were sold for.
 *
 * **A refund is an entry, not an edit.** The sale's row is never touched
 * (`app_rw` could not if it tried): a refund is a second row for the same
 * line, negative, and what the line is worth is the sum.
 *
 * **In proportion to the units that came back, of what was actually paid.**
 * Our own amount is the base rather than Shopify's refund subtotal, so a
 * refund can never take back more than the sale put in, and both are on the
 * same footing — the price as the shop charged it. The last units take what
 * is left, so three bottles for ten euros refund to exactly ten.
 *
 * **Only lines that are ours.** The join is to a sale already recorded under
 * this scope's policy: a refund for a wine the shopper found themselves joins
 * nothing, and so does one for another winery's order.
 */
export const recordRefunds = async (
  tx: DbTransaction,
  { orderIds, lines }: RefundToRecord,
): Promise<number> => {
  if (lines.length === 0 || orderIds.length === 0) return 0;

  const rows = JSON.stringify(
    lines.map((line) => ({
      refund_line_id: line.refundLineId,
      line_item_ids: line.lineItemIds,
      quantity: line.quantity,
    })),
  );

  const inserted = await tx.execute(sql`
    INSERT INTO attributions (
      tenant_id, shop, order_id, line_item_id, session_id, conversation_id, product_id,
      quantity, amount_cents, currency, ordered_at, refund_line_id
    )
    SELECT
      s.tenant_id, s.shop, s.order_id, s.line_item_id, s.session_id, s.conversation_id,
      s.product_id,
      -least(r.quantity, s.quantity + back.quantity),
      -CASE
        WHEN r.quantity >= s.quantity + back.quantity THEN s.amount_cents + back.amount_cents
        ELSE least(
          s.amount_cents + back.amount_cents,
          round(s.amount_cents::numeric * r.quantity / s.quantity)::int
        )
      END,
      s.currency,
      s.ordered_at,
      r.refund_line_id
    FROM jsonb_to_recordset(${rows}::jsonb) AS r(
      refund_line_id text, line_item_ids jsonb, quantity int
    )
    JOIN attributions s
      -- Sales only. A refund row could never pass the WHERE below either (its
      -- units are negative), so this is not what keeps a refund from being
      -- refunded; it is what names the sales' own partial unique index.
      ON s.refund_line_id IS NULL
      AND s.order_id IN (SELECT jsonb_array_elements_text(${JSON.stringify(orderIds)}::jsonb))
      AND s.line_item_id IN (SELECT jsonb_array_elements_text(r.line_item_ids))
    CROSS JOIN LATERAL (
      SELECT coalesce(sum(d.quantity), 0)::int AS quantity,
             coalesce(sum(d.amount_cents), 0)::int AS amount_cents
      FROM attributions d
      WHERE d.refund_line_id IS NOT NULL
        AND d.order_id = s.order_id
        AND d.line_item_id = s.line_item_id
    ) back
    WHERE r.quantity > 0 AND s.quantity + back.quantity > 0
    ON CONFLICT (tenant_id, refund_line_id) WHERE refund_line_id IS NOT NULL DO NOTHING
    RETURNING id
  `);

  return [...inserted].length;
};
