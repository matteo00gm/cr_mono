import { getTableConfig } from 'drizzle-orm/pg-core';
import { describe, expect, it } from 'vitest';

import { EMBEDDING_DIMENSIONS, productEmbeddings } from '../../src/schema/product-embeddings.js';

/**
 * Shape assertions for `product_embeddings` (P0-27).
 *
 * The column type and dimension are effectively permanent — changing either
 * means re-embedding every product in every tenant — so they are pinned here
 * where a change is visible in review rather than discovered in a reindex.
 */

const config = getTableConfig(productEmbeddings);
const columns = new Map(config.columns.map((column) => [column.name, column]));

describe('product_embeddings schema', () => {
  it('stores half-precision vectors at the bake-off dimension', () => {
    // halfvec, not vector: the 3x memory reduction is what keeps the HNSW index
    // inside shared_buffers on a t4g.micro. Once it does not fit, every query
    // pays disk and the fix is a bigger instance.
    expect(columns.get('embedding')?.getSQLType()).toBe(`halfvec(${String(EMBEDDING_DIMENSIONS)})`);
    expect(EMBEDDING_DIMENSIONS).toBe(1024);
  });

  it('hands the driver a pgvector literal, not a Postgres array', () => {
    /*
     * `[0.1,0.2]`, not `{0.1,0.2}`.
     *
     * Left to postgres-js, a JS array is serialised as a Postgres array literal
     * with braces, which halfvec refuses — so the mapping is what makes the
     * column usable at all. Worth an assertion because the failure appears at
     * the first insert, far from this line.
     */
    const driverValue = columns.get('embedding')?.mapToDriverValue([0.1, 0.2, 0.3]);

    expect(driverValue).toBe('[0.1,0.2,0.3]');
  });

  it('records the model per row, and does not duplicate the dimension', () => {
    // A model change is the likeliest thing to happen to this table, and the
    // useful question then is "which rows are still on the old model". A global
    // constant makes a half-migrated table look identical to a finished one.
    expect(columns.get('model')?.notNull).toBe(true);

    // No `dim`: halfvec(1024) already refuses any other length, so the column
    // could only ever hold 1024 — while nothing would force it to say so. A
    // denormalised copy that can disagree with what it copies is worse than
    // none. Per-row versioning is P1-49's `version`, not this.
    expect(columns.get('dim')).toBeUndefined();
  });

  it('keeps one vector per chunk per product', () => {
    // The re-embed key: an update is an upsert, not an append. Without it,
    // re-indexing a product doubles its vectors and skews every ranking.
    const constraint = config.uniqueConstraints.find(
      (c) => c.name === 'product_embeddings_tenant_product_chunk_unique',
    );

    expect(constraint?.columns.map((c) => c.name)).toEqual([
      'tenant_id',
      'product_id',
      'chunk_idx',
    ]);
  });

  it('cascades from both tenants and products', () => {
    // §4.3: a vector that outlives its product is a recommendation for
    // something nobody can buy.
    const targets = config.foreignKeys.map(
      (fk) => getTableConfig(fk.reference().foreignTable).name,
    );

    expect(targets.sort()).toEqual(['products', 'tenants']);
    expect(config.foreignKeys.every((fk) => fk.onDelete === 'cascade')).toBe(true);
  });
});
