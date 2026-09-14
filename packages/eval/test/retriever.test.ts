import type { ProductInsert } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import type { EvalQuery } from '../src/dataset.js';
import { lexicalRetriever, terms } from '../src/retriever.js';
import type { SeededCatalog, SeededProduct } from '../src/seed.js';

/** The lexical stand-in for P2-20 (P1-46): deterministic, and honest about matching nothing. */

const wine = (sku: string, over: Partial<ProductInsert> = {}): SeededProduct => ({
  id: `id-${sku}`,
  product: {
    sku,
    name: sku,
    wineType: 'rosso',
    priceCents: 1000,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
    ...over,
  },
});

const query = (text: string): EvalQuery => ({
  id: 'q01',
  catalog: 'broad',
  kind: 'dish',
  locale: 'it',
  query: text,
  acceptable: ['A'],
  rationale: 'A rationale long enough to pass.',
});

const catalog: SeededCatalog = {
  id: 'broad',
  products: [
    wine('A', { name: 'Barolo', foodPairings: ['brasato'] }),
    wine('B', { name: 'Barbera', foodPairings: ['brasato', 'bollito'] }),
    wine('C', { name: 'Moscato', wineType: 'spumante', foodPairings: ['dolci'] }),
    wine('D', { name: 'Dolcetto', foodPairings: ['bollito', 'brasato'] }),
  ],
};

describe('terms', () => {
  it('lowercases, strips accents, and drops short words and stopwords', () => {
    expect(terms('Un Rosé per la Bistecca, sotto i 20 EURO — più forte')).toEqual([
      'rose',
      'bistecca',
      'forte',
    ]);
  });

  it('keeps a word whole across an accent inside it', () => {
    expect(terms('Gewürztraminer')).toEqual(['gewurztraminer']);
  });
});

describe('lexicalRetriever', () => {
  it('ranks by shared words, breaks ties in catalogue order, and leaves out wines sharing none', async () => {
    const ranked = await lexicalRetriever(catalog, query('brasato o bollito'));

    expect(ranked.map((seeded) => seeded.product.sku)).toEqual(['B', 'D', 'A']);
  });

  it('counts a word the query repeats once', async () => {
    const ranked = await lexicalRetriever(catalog, query('dolci dolci brasato'));

    // Counted twice, `dolci` would put C first; counted once, every wine ties.
    expect(ranked.map((seeded) => seeded.product.sku)).toEqual(['A', 'B', 'C', 'D']);
  });

  it('returns nothing for a question no wine shares a word with', async () => {
    expect(await lexicalRetriever(catalog, query('un whisky torbato'))).toEqual([]);
  });
});
