import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * Stock as the shop reports it (P6-11, §4.4): one statement, on the caller's
 * transaction, under the scope's tenant.
 *
 * **Stock and nothing else, so it costs no embedding.** Stock was kept out of
 * the text a wine is embedded from on purpose (P1-33), so `content_hash` does
 * not move and nothing here writes an outbox row: a wine that sells out is one
 * indexed `UPDATE`, in effect on the next question a shopper asks.
 *
 * **The later word wins, whatever order it arrives in.** Shopify redelivers,
 * and a delivery we asked it to send again arrives after news that replaced
 * it. Each wine remembers the moment its stock was true (`stock_source_at`),
 * and a report older than that changes nothing. A report from the same instant
 * is applied only if it says something different — so a redelivery of what is
 * already there writes no row at all.
 *
 * **A variant the catalogue does not hold matches nothing**, and is not an
 * error: most of a shop's products are not wines we were given.
 */

export interface StockToSync {
  /** Shopify's numeric variant id, as `external_variant_id` holds it (P3-11). */
  readonly variantId: string;
  readonly status: 'IN_STOCK' | 'OUT_OF_STOCK' | 'PREORDER';
  /** Units on hand, or `null` when the shop does not count this wine. */
  readonly quantity: number | null;
}

export interface StockReport {
  /** When the shop says this was true. Absent, it is taken as now. */
  readonly sourceAt: Date | undefined;
  readonly variants: readonly StockToSync[];
}

/** How many wines this report changed — none for a variant we do not hold, an older report, or a repeat. */
export const syncStock = async (
  tx: DbTransaction,
  { sourceAt, variants }: StockReport,
): Promise<number> => {
  if (variants.length === 0) return 0;

  const rows = JSON.stringify(
    variants.map((variant) => ({
      variant_id: variant.variantId,
      status: variant.status,
      quantity: variant.quantity,
    })),
  );

  const updated = await tx.execute(sql`
    WITH report AS (
      SELECT v.variant_id,
             v.status::product_stock_status AS status,
             v.quantity,
             coalesce(${sourceAt?.toISOString() ?? null}::timestamptz, now()) AS source_at
      FROM jsonb_to_recordset(${rows}::jsonb) AS v(variant_id text, status text, quantity int)
    )
    UPDATE products p
    SET stock_status = r.status,
        stock_qty = r.quantity,
        stock_source_at = r.source_at
    FROM report r
    WHERE p.external_variant_id = r.variant_id
      AND (
        p.stock_source_at IS NULL
        OR p.stock_source_at < r.source_at
        OR (
          p.stock_source_at = r.source_at
          AND (p.stock_status, p.stock_qty) IS DISTINCT FROM (r.status, r.quantity)
        )
      )
    RETURNING p.id
  `);

  return [...updated].length;
};
