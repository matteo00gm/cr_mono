import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * What the sommelier sold over a range (P6-10, §2.4), read from `attributions`
 * in the scope's tenant.
 *
 * **Net of refunds, line by line.** `attributions` is a ledger (P6-08): a sale,
 * and beside it whatever a refund took back. Each line is summed first, and a
 * line with nothing left of it is left out of every number — so an order
 * refunded in full is not an order with no bottles and no money, it is not
 * there.
 *
 * **By when the order was placed.** A refund carries its sale's date, so it
 * reduces the range the sale was counted in rather than a later one.
 */

export interface SalesQuery {
  /** The first instant counted. */
  readonly start: Date;
  /** The first instant not counted: the range is `[start, end)`. */
  readonly end: Date;
}

export interface AttributedSales {
  /** Orders with at least one line of ours still standing. */
  readonly orders: number;
  /** Visits that bought: the anonymous per-tab ids those lines carried (P3-16). */
  readonly visits: number;
  /** Bottles, after refunds. */
  readonly units: number;
  /**
   * What was paid for them, after refunds, in hundredths — per currency,
   * because adding euros to francs is not a number. Largest first.
   */
  readonly amounts: readonly { readonly currency: string; readonly cents: number }[];
}

export const readAttributedSales = async (
  tx: DbTransaction,
  { start, end }: SalesQuery,
): Promise<AttributedSales> => {
  /*
   * One row per currency, each carrying the same three totals: a winery sells
   * in one currency, so this is one row, and the join keeps it one statement
   * when it is not. A line's own sum needs no cast — it is never more than
   * the one sale it starts from — but the range's total can pass 32 bits, and
   * is read as `float8`: a `bigint` arrives as text, and every amount here is
   * far inside what a double holds exactly.
   */
  const rows = await tx.execute(sql`
    WITH lines AS (
      SELECT order_id, line_item_id, currency,
             max(session_id) AS session_id,
             sum(quantity)::int AS units,
             sum(amount_cents) AS cents
      FROM attributions
      WHERE ordered_at >= ${start.toISOString()}::timestamptz
        AND ordered_at < ${end.toISOString()}::timestamptz
      GROUP BY order_id, line_item_id, currency
    ),
    kept AS (SELECT * FROM lines WHERE units > 0)
    SELECT t.orders, t.visits, t.units, c.currency, c.cents
    FROM (
      SELECT count(DISTINCT order_id)::int AS orders,
             count(DISTINCT session_id)::int AS visits,
             coalesce(sum(units), 0)::int AS units
      FROM kept
    ) t
    LEFT JOIN (
      SELECT currency, sum(cents)::float8 AS cents FROM kept GROUP BY currency
    ) c ON true
    ORDER BY c.cents DESC NULLS LAST, c.currency
  `);

  const read = [...rows] as {
    orders: number;
    visits: number;
    units: number;
    currency: string | null;
    cents: number | null;
  }[];
  const [first] = read;

  return {
    orders: first?.orders ?? 0,
    visits: first?.visits ?? 0,
    units: first?.units ?? 0,
    amounts: read.flatMap(({ currency, cents }) =>
      currency === null || cents === null ? [] : [{ currency, cents }],
    ),
  };
};
