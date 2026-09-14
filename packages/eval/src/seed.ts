import { randomUUID } from 'node:crypto';

import type { CandidateProduct } from '@catalogorosso/core';
import type { ProductInsert } from '@catalogorosso/db';

import type { CatalogId, EvalDataset } from './dataset.js';

/** A catalogue wine with the id seeding gave it. */
export interface SeededProduct {
  readonly id: string;
  readonly product: ProductInsert;
}

export interface SeededCatalog {
  readonly id: CatalogId;
  readonly products: readonly SeededProduct[];
}

/**
 * The catalogues with product ids assigned, as seeding a tenant assigns them (P1-46).
 *
 * The labels name SKUs because the ids are not known until this point, and the
 * harness maps every recommended id back to a SKU through the candidates it
 * handed over — so an id the model was never given cannot score.
 */
export const seedCatalogs = (dataset: EvalDataset): ReadonlyMap<CatalogId, SeededCatalog> =>
  new Map(
    dataset.catalogs.map((catalog) => [
      catalog.id,
      {
        id: catalog.id,
        products: catalog.products.map((product) => ({ id: randomUUID(), product })),
      },
    ]),
  );

/**
 * A seeded wine as retrieval hands it to the model: the embeddable fields and
 * the id, and nothing else — no SKU, no stock, nothing the product would not
 * send either.
 */
export const toCandidate = ({ id, product }: SeededProduct): CandidateProduct => ({
  id,
  name: product.name,
  producer: product.producer,
  vintage: product.vintage,
  wineType: product.wineType,
  grapeVarieties: product.grapeVarieties,
  region: product.region,
  denomination: product.denomination,
  styleTags: product.styleTags,
  tastingNotes: product.tastingNotes,
  foodPairings: product.foodPairings,
  alcoholPct: product.alcoholPct,
  priceCents: product.priceCents,
});
