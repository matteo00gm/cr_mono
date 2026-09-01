import { customType, integer, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';

import { products } from './products.js';
import { tenants } from './tenants.js';

/**
 * `product_embeddings` — the retrieval hot path (P0-27).
 *
 * Column type and dimension are effectively permanent: changing either means
 * re-embedding every product in every tenant (§Open Decision 1). P1-49 adds the
 * per-tenant version pointer that makes such a change possible without downtime;
 * this table's job is to be correct enough that it is not needed early.
 */

/**
 * `halfvec(1024)` — half-precision, from pgvector 0.7+ (asserted in bootstrap).
 *
 * The 3x memory reduction is what keeps the HNSW index inside `shared_buffers`
 * on a `t4g.micro` (§5.1). Once the index no longer fits, every query pays disk,
 * and the fix is a bigger instance — the largest line in the bill. Drizzle has
 * no built-in for the type, so it is declared here.
 */
const halfvec = (name: string, dimensions: number) =>
  customType<{ data: number[]; driverData: string }>({
    dataType: () => `halfvec(${String(dimensions)})`,
    toDriver: (value) => JSON.stringify(value),
  })(name);

/** Titan V2 at 1024 (§P1 bake-off). Enforced by the column type alone — see `embedding`. */
export const EMBEDDING_DIMENSIONS = 1024;

export const productEmbeddings = pgTable(
  'product_embeddings',
  {
    id: uuid('id').primaryKey().defaultRandom(),

    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),

    /**
     * `ON DELETE CASCADE`, so §4.3's "deleting a product deletes its vectors" is
     * partly the database's job rather than entirely P1-04's. A vector that
     * outlives its product is a recommendation for something nobody can buy.
     */
    productId: uuid('product_id')
      .notNull()
      .references(() => products.id, { onDelete: 'cascade' }),

    chunkIdx: integer('chunk_idx').notNull(),

    /** Matches `products.content_hash`: what this vector was computed from. */
    contentHash: text('content_hash').notNull(),

    embedding: halfvec('embedding', EMBEDDING_DIMENSIONS).notNull(),

    /**
     * Per row, not assumed globally.
     *
     * A model change is the thing most likely to happen to this table, and when
     * it does the useful question is "which rows are still on the old model" —
     * answerable only if each row says. A global constant would make a
     * half-migrated table indistinguishable from a finished one.
     *
     * There is deliberately no companion `dim` column. §P0-27 suggests storing
     * the dimension per row alongside the model, but `halfvec(1024)` already
     * enforces it: a vector of any other length is refused outright, with
     * SQLSTATE 22000. So `dim` could only ever hold 1024 — while nothing would
     * constrain it to actually say 1024, since no check ties an integer column
     * to the length of a vector beside it. A denormalised copy that can silently
     * disagree with the thing it copies is worse than no copy. The per-row
     * versioning this was reaching for is P1-49's `version smallint`, which
     * joins the unique key and is read by retrieval.
     */
    model: text('model').notNull(),

    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [
    /** One vector per chunk per product. The re-embed key: upsert, not append. */
    unique('product_embeddings_tenant_product_chunk_unique').on(
      table.tenantId,
      table.productId,
      table.chunkIdx,
    ),
  ],
);
