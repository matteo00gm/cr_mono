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
    ON CONFLICT (tenant_id, order_id, line_item_id) DO NOTHING
    RETURNING id
  `);

  return [...inserted].length;
};
