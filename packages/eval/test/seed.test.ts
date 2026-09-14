import { describe, expect, it } from 'vitest';

import { loadDataset } from '../src/dataset.js';
import { seedCatalogs, toCandidate } from '../src/seed.js';

/** Seeding the catalogues in memory (P1-46): fresh ids, and candidates carrying only what the model may see. */

const dataset = loadDataset();

describe('seedCatalogs', () => {
  it('gives every wine in every catalogue an id of its own, fresh on every run', () => {
    const seeded = seedCatalogs(dataset);
    const ids = [...seeded.values()].flatMap((catalog) => catalog.products.map((wine) => wine.id));

    expect(seeded.get('broad')?.products).toHaveLength(40);
    expect(new Set(ids).size).toBe(120);
    expect(seedCatalogs(dataset).get('broad')?.products[0]?.id).not.toBe(
      seeded.get('broad')?.products[0]?.id,
    );
  });
});

describe('toCandidate', () => {
  it('hands the model the id and the embeddable fields, and no SKU, stock or currency', () => {
    const first = seedCatalogs(dataset).get('broad')?.products[0];
    if (first === undefined) throw new Error('expected a seeded wine');

    const candidate = toCandidate(first);

    expect(candidate.id).toBe(first.id);
    expect(candidate.name).toBe(first.product.name);
    expect(candidate.tastingNotes).toBe(first.product.tastingNotes);
    expect(Object.keys(candidate)).not.toEqual(expect.arrayContaining(['sku']));
    expect('stockStatus' in candidate || 'currency' in candidate || 'sku' in candidate).toBe(false);
  });
});
