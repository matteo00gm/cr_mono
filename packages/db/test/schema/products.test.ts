import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import {
  productEmbeddingState,
  products,
  productStatus,
  productStockStatus,
} from '../../src/schema/products.js';

/**
 * Shape assertions for `products` (P0-26).
 *
 * This table is the contract three import paths validate against (§2.2a) and
 * the one P0-42 derives its Zod schemas from, so its shape is load-bearing for
 * code that does not exist yet.
 */

const config = getTableConfig(products);
const columns = new Map(config.columns.map((column) => [column.name, column]));

describe('products schema', () => {
  it('stores money as integer minor units', () => {
    // Money in floating point produces the 12.499999 that shows up in a cart
    // total and nowhere in the data.
    expect(columns.get('price_cents')?.getSQLType()).toBe('integer');
    expect(columns.get('price_cents')?.notNull).toBe(true);
  });

  it('stores alcohol_pct as numeric, not a float', () => {
    // 13.5% has to round-trip as 13.5.
    expect(columns.get('alcohol_pct')?.getSQLType()).toBe('numeric(4, 2)');
  });

  it.each(['grape_varieties', 'style_tags', 'food_pairings'])(
    'keeps %s as an array, not a delimited string',
    (column) => {
      // GIN indexes in P1-07 need real arrays; a comma-joined string is also a
      // parsing bug waiting for the first grape with a comma in its name.
      expect(columns.get(column)?.getSQLType()).toBe('text[]');
    },
  );

  it('upserts on (tenant_id, sku)', () => {
    // The key P1-24's import matches on. Anything else and a re-import either
    // duplicates the catalog or overwrites the wrong row.
    const constraint = config.uniqueConstraints.find(
      (c) => c.name === 'products_tenant_sku_unique',
    );

    expect(constraint?.columns.map((c) => c.name)).toEqual(['tenant_id', 'sku']);
  });

  it('leaves external_variant_id nullable although the form requires it', () => {
    // A legacy row may predate it. NOT NULL would force the import path to
    // invent a value, which fails at the checkout instead of at the form.
    expect(columns.get('external_variant_id')?.notNull).toBe(false);
  });

  it('carries no speculative columns for the enrichment §4.2 cut', () => {
    // Enrichment was cut from launch so the ZERO_RESULTS panel can show whether
    // thin catalogs actually hurt retrieval. Reserving a shape now would guess
    // at a schema for a feature deliberately left undesigned — and ADD COLUMN
    // is metadata-only in Postgres, so there is nothing to save by guessing.
    expect([...columns.keys()].filter((name) => name.startsWith('enriched_'))).toEqual([]);
  });

  it('declares the lifecycle and indexing states', () => {
    expect(productStatus.enumValues).toEqual(['ACTIVE', 'ARCHIVED']);
    expect(productEmbeddingState.enumValues).toEqual(['PENDING', 'INDEXED', 'FAILED', 'STALE']);
    expect(productStockStatus.enumValues).toEqual(['IN_STOCK', 'OUT_OF_STOCK', 'PREORDER']);
  });

  it('starts a product ACTIVE and unindexed', () => {
    // PENDING, not INDEXED: a product that claims to be indexed before the
    // worker has seen it is a product that silently never gets embedded.
    expect(columns.get('status')?.default).toBe('ACTIVE');
    expect(columns.get('embedding_state')?.default).toBe('PENDING');
  });

  it('guards the values an import can get wrong', () => {
    const names = config.checks.map((c) => c.name);

    expect(names).toContain('products_price_non_negative');
    expect(names).toContain('products_stock_qty_non_negative');
    expect(names).toContain('products_alcohol_pct_non_negative');
  });

  it('cascades from tenants.id', () => {
    const [foreignKey] = config.foreignKeys;
    const reference = foreignKey?.reference();

    expect(getTableConfig(reference?.foreignTable ?? products).name).toBe('tenants');
    expect(foreignKey?.onDelete).toBe('cascade');
  });
});
