import type { ProductRow } from '@catalogorosso/db';

import type { ProductsPort } from '../../src/products.js';

/**
 * A products port with nothing stubbed (P1-02 onward).
 *
 * **Every method rejects by default, and that is the useful part.** A test that
 * forgets to stub the method it exercises fails with "not stubbed" rather than
 * with `undefined is not a function` three frames away — and a test that
 * accidentally reaches a method it did not mean to fails at all, instead of
 * quietly passing against a resolved promise.
 *
 * Shared because the port grows with every catalogue row, and three copies of
 * this object would each have to learn about the new method separately: the two
 * that forgot would keep compiling.
 */
export const productsPort = (overrides: Partial<ProductsPort> = {}): ProductsPort => ({
  create: () => Promise.reject(new Error('products.create is not stubbed in this test')),
  update: () => Promise.reject(new Error('products.update is not stubbed in this test')),
  archive: () => Promise.reject(new Error('products.archive is not stubbed in this test')),
  ...overrides,
});

/** Timestamps a stored row carries. Fixed so assertions can name them. */
export const STORED_AT = new Date('2026-09-08T09:14:00.000Z');

/**
 * A row shaped the way the database actually returns one.
 *
 * **`Date` objects, not ISO strings.** The routes hand rows to `c.json`, which
 * serialises a `Date` — so a fake carrying strings would agree with the
 * response contract for the wrong reason and prove nothing about what the real
 * path emits. This is the shape A1 got wrong by writing the fake and the code
 * from one assumption.
 */
export const storedProduct = (overrides: Partial<ProductRow> = {}): ProductRow => ({
  id: '7c9e6679-7425-40de-944b-e07fc1f90ae7',
  tenantId: '11111111-1111-1111-1111-111111111111',
  sku: 'BAR-2019',
  externalVariantId: null,
  name: 'Barolo Bussia',
  producer: null,
  vintage: null,
  wineType: 'red',
  grapeVarieties: null,
  region: null,
  denomination: null,
  styleTags: null,
  tastingNotes: null,
  foodPairings: null,
  alcoholPct: null,
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
  stockQty: null,
  productUrl: null,
  imageUrl: null,
  status: 'ACTIVE',
  contentHash: 'a'.repeat(64),
  embeddingState: 'PENDING',
  createdAt: STORED_AT,
  updatedAt: STORED_AT,
  ...overrides,
});
