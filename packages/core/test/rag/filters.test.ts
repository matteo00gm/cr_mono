import { describe, expect, it } from 'vitest';

import { applyFilters, type FilterableCandidate } from '../../src/rag/filters.js';

/**
 * Availability and price filtering (P2-21).
 *
 * Two rules that look alike and are not. A price ceiling is something the
 * visitor said, so it is hard: no fallback, ever. Out of stock is something the
 * catalogue says, so it is soft: a sold-out wine still answers the question,
 * and a visitor who asked for a Barolo under 40 euro would rather see the one
 * that is sold out than be told there is nothing.
 *
 * The third rule is the quiet one: order comes from fusion and is never
 * recomputed here, because a filter that reorders is a second ranking.
 */

interface Wine extends FilterableCandidate {
  readonly productId: string;
}

const wine = (productId: string, stockStatus: Wine['stockStatus'], priceCents: number): Wine => ({
  productId,
  stockStatus,
  priceCents,
});

const ids = (candidates: readonly Wine[]): string[] => candidates.map((c) => c.productId);

describe('availability', () => {
  it('excludes a sold-out wine while anything else matches', () => {
    const result = applyFilters([
      wine('sold-out', 'OUT_OF_STOCK', 2000),
      wine('stocked', 'IN_STOCK', 2000),
    ]);

    expect(ids(result.candidates)).toEqual(['stocked']);
    expect(result.outOfStockOnly).toBe(false);
  });

  it('returns sold-out wines flagged when nothing else matches', () => {
    /*
     * §1.5: the widget shows the badge and suppresses add-to-cart. Returning
     * nothing instead would tell a visitor the cellar is empty, which is both
     * untrue and the worse answer — the wine exists and can be asked about.
     */
    const result = applyFilters([
      wine('sold-out', 'OUT_OF_STOCK', 2000),
      wine('also-sold-out', 'OUT_OF_STOCK', 3000),
    ]);

    expect(ids(result.candidates)).toEqual(['sold-out', 'also-sold-out']);
    expect(result.outOfStockOnly).toBe(true);
  });

  it('treats a preorder as available, because it can be ordered', () => {
    const result = applyFilters([
      wine('preorder', 'PREORDER', 2000),
      wine('sold-out', 'OUT_OF_STOCK', 2000),
    ]);

    expect(ids(result.candidates)).toEqual(['preorder']);
    expect(result.outOfStockOnly).toBe(false);
  });

  it('flags nothing when nothing matched at all', () => {
    const result = applyFilters([]);

    expect(result.candidates).toEqual([]);
    // Not "everything we found is sold out" — we found nothing. §2.4 tells them apart.
    expect(result.outOfStockOnly).toBe(false);
  });

  it('keeps the order fusion produced, rather than ranking again', () => {
    const result = applyFilters([
      wine('third', 'IN_STOCK', 500),
      wine('first', 'IN_STOCK', 9000),
      wine('second', 'IN_STOCK', 1000),
    ]);

    expect(ids(result.candidates)).toEqual(['third', 'first', 'second']);
  });
});

describe('a price ceiling', () => {
  it('excludes anything above it', () => {
    const result = applyFilters([wine('cheap', 'IN_STOCK', 1500), wine('dear', 'IN_STOCK', 4000)], {
      maxPriceCents: 3000,
    });

    expect(ids(result.candidates)).toEqual(['cheap']);
  });

  it('includes a wine priced exactly at it', () => {
    // "Under 30 euro" and "around 30 euro" both mean the shelf at 30. A caller
    // that means strictly under passes one cent less.
    const result = applyFilters([wine('exact', 'IN_STOCK', 3000)], { maxPriceCents: 3000 });

    expect(ids(result.candidates)).toEqual(['exact']);
  });

  it('has no fallback: a visitor who said under thirty is not shown forty', () => {
    const result = applyFilters([wine('dear', 'IN_STOCK', 4000)], { maxPriceCents: 3000 });

    expect(result.candidates).toEqual([]);
    expect(result.outOfStockOnly).toBe(false);
  });

  it('applies before the sold-out fallback, so the fallback stays affordable', () => {
    /*
     * The wine that comes back is the one the visitor could have bought. A
     * fallback drawn before the ceiling would answer "nothing in stock under
     * 30" with a 40-euro bottle that is also sold out — wrong twice.
     */
    const result = applyFilters(
      [wine('dear-and-gone', 'OUT_OF_STOCK', 4000), wine('cheap-and-gone', 'OUT_OF_STOCK', 2000)],
      { maxPriceCents: 3000 },
    );

    expect(ids(result.candidates)).toEqual(['cheap-and-gone']);
    expect(result.outOfStockOnly).toBe(true);
  });

  it('applies no ceiling when the caller supplies none', () => {
    const result = applyFilters([wine('dear', 'IN_STOCK', 900_000)], {});

    expect(ids(result.candidates)).toEqual(['dear']);
  });

  it('treats a ceiling of zero as a ceiling, not as absent', () => {
    // `filters.maxPriceCents ?? Infinity` would be the same; `|| Infinity` is
    // the version that silently drops a free-bottle constraint.
    const result = applyFilters([wine('any', 'IN_STOCK', 100)], { maxPriceCents: 0 });

    expect(result.candidates).toEqual([]);
  });
});

describe('the candidates it returns', () => {
  it('passes each one through untouched, so nothing downstream is re-derived', () => {
    const stocked = wine('stocked', 'IN_STOCK', 2000);
    const result = applyFilters([stocked, wine('sold-out', 'OUT_OF_STOCK', 2000)]);

    expect(result.candidates[0]).toBe(stocked);
  });

  it('leaves the input alone', () => {
    const input = [wine('sold-out', 'OUT_OF_STOCK', 2000), wine('stocked', 'IN_STOCK', 2000)];

    applyFilters(input);

    expect(ids(input)).toEqual(['sold-out', 'stocked']);
  });
});
