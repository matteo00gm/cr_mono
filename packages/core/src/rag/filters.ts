import type { StockStatus } from '@catalogorosso/db';

/**
 * Availability and price filtering, after fusion (P2-21, §4.4).
 *
 * **After fusion, never inside a branch.** Filtering a branch's own query
 * changes the ranks of everything below what it removed, and RRF then fuses a
 * ranking that never existed — the fused order would be an artefact of which
 * wines were out of stock rather than of which wines answer the question.
 *
 * **Pure, and structural.** It takes anything carrying a stock status and a
 * price, so the fused candidates flow through unchanged and nothing here needs
 * a driver or a product type.
 *
 * **It parses nothing.** A ceiling arrives already in minor units, from the
 * caller that read the visitor's message — the row is explicit that this is
 * structured rather than model-inferred, because a model inferring a budget is
 * a model deciding what a visitor can afford.
 */

/**
 * §2.2's availability states.
 *
 * Taken from the schema's own enum rather than restated (P0-42), and re-exported
 * so a caller of this module needs one import rather than two. A *type* import,
 * so no driver reaches this file — and a fourth state added to the column
 * arrives here by compiling, instead of being silently treated as available.
 */
export type { StockStatus };

/**
 * The little a filter needs to know about a wine.
 *
 * Deliberately not `CandidateProduct`: filtering runs on what `fusedSearch`
 * returns, which is an id and the two columns below, and widening this would
 * force retrieval to fetch a whole product to answer a question about stock.
 */
export interface FilterableCandidate {
  readonly stockStatus: StockStatus;
  /**
   * Minor units, in the tenant's currency (§2.2 sets one per tenant), which is
   * the currency a ceiling is therefore in as well. A tenant that ever priced
   * two wines in two currencies would need the ceiling to carry one too — see
   * the open item on P2-21 in the plan.
   */
  readonly priceCents: number;
}

export interface RetrievalFilters {
  /**
   * The most a visitor is willing to spend, in minor units, inclusive.
   *
   * Inclusive because "under 30 euro" and "around 30 euro" both mean the shelf
   * at 30, and a caller that means strictly under can pass one cent less.
   */
  readonly maxPriceCents?: number | undefined;
}

export interface FilterResult<T> {
  /** What survived, in the order fusion produced. */
  readonly candidates: readonly T[];
  /**
   * Every candidate above is out of stock (§1.5).
   *
   * The widget shows the badge and suppresses add-to-cart; it does not tell a
   * visitor the cellar is empty, which is what excluding them unconditionally
   * would amount to when nothing else matches.
   */
  readonly outOfStockOnly: boolean;
}

/** `PREORDER` is available: a visitor can order it, which is the question. */
const available = (candidate: FilterableCandidate): boolean =>
  candidate.stockStatus !== 'OUT_OF_STOCK';

/**
 * Filter fused candidates on availability and price.
 *
 * **A price ceiling is hard and has no fallback.** A visitor who says "under 30
 * euro" has not asked to see 40-euro bottles, and showing them anyway is the
 * recommendation engine overriding the one thing the visitor stated outright.
 * Out of stock is soft by contrast, because a sold-out wine still answers the
 * question — it just cannot be bought today.
 *
 * The ceiling applies first, so the out-of-stock fallback is drawn only from
 * wines the visitor could have afforded.
 */
export const applyFilters = <T extends FilterableCandidate>(
  candidates: readonly T[],
  filters: RetrievalFilters = {},
): FilterResult<T> => {
  const ceiling = filters.maxPriceCents;
  const affordable =
    ceiling === undefined ? candidates : candidates.filter((c) => c.priceCents <= ceiling);

  const inStock = affordable.filter(available);

  return inStock.length > 0
    ? { candidates: inStock, outOfStockOnly: false }
    : { candidates: affordable, outOfStockOnly: affordable.length > 0 };
};
