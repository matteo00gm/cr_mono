import type { Product } from '@catalogorosso/api-client';

/**
 * A complete product as the API returns it, with whatever a test overrides.
 *
 * Every field is present because `Product` requires every field — a fixture
 * that cast a partial object would let a component read a property the real
 * response always carries and the test never supplied.
 */
export const wine = (over: Partial<Product> = {}): Product => ({
  id: 'p1',
  sku: 'BAR-2019',
  externalVariantId: null,
  name: 'Barolo Bussia',
  producer: null,
  vintage: 2019,
  wineType: 'red',
  grapeVarieties: null,
  region: null,
  denomination: null,
  styleTags: null,
  tastingNotes: null,
  foodPairings: null,
  alcoholPct: null,
  priceCents: 2500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
  stockQty: null,
  productUrl: null,
  imageUrl: null,
  status: 'ACTIVE',
  embeddingState: 'INDEXED',
  completeness: 40,
  createdAt: '2026-09-01T10:00:00.000Z',
  updatedAt: '2026-09-01T10:00:00.000Z',
  ...over,
});
