import { and, eq, sql } from 'drizzle-orm';

import type { EmbeddingState } from './products-read.js';
import { productEmbeddings } from './schema/product-embeddings.js';
import { products } from './schema/products.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Reading a product for embedding, and writing the vector back (P1-37).
 *
 * The statements live here so no app imports a driver (P0-09). What text a
 * wine becomes, and whether it is worth re-embedding, stays in
 * `packages/core/src/rag` — this module knows only which columns to fetch and
 * where the vector goes.
 */

/**
 * Everything the worker needs about one product, in one round trip.
 *
 * **The two hashes are different things and the difference is the whole
 * subtlety of this file.** `products.content_hash` is written at *write* time
 * by `insertProduct` and `updateProduct`, so it says "the hash of the text as
 * of the last edit" — P1-03 compares a patch against it to decide whether an
 * edit is worth re-indexing. `product_embeddings.content_hash` says "the hash
 * of the text the stored vector was actually built from".
 *
 * Only the second one answers "does this wine need embedding". Feeding
 * `shouldEmbed` the first would make it true on every freshly created product
 * — the insert already set it — and the worker would skip the entire
 * catalogue for ever, with no error anywhere. Which is the failure P1-31 just
 * fixed a different version of.
 */
export interface EmbeddableRow {
  readonly id: string;
  readonly tenantId: string;
  readonly status: string;
  readonly embeddingState: EmbeddingState;
  readonly embeddingError: string | null;
  readonly embeddingAttempts: number;
  /** From `product_embeddings`, or null when nothing has ever been stored. */
  readonly embeddedHash: string | null;

  readonly name: string;
  readonly producer: string | null;
  readonly vintage: number | null;
  readonly wineType: string;
  readonly grapeVarieties: string[] | null;
  readonly region: string | null;
  readonly denomination: string | null;
  readonly styleTags: string[] | null;
  readonly tastingNotes: string | null;
  readonly foodPairings: string[] | null;
  readonly alcoholPct: string | null;
  readonly priceCents: number;
}

/** The chunk this pipeline writes. One document per wine, for now. */
export const EMBEDDING_CHUNK = 0;

/**
 * Reads one product and the hash of its stored vector.
 *
 * **Scoped by the caller's `withTenant`, and that scoping *is* the tenant
 * check the P1-37 row asks for.** A message naming the wrong tenant opens a
 * transaction for that tenant, and the policy then matches no row — so the job
 * reports "gone" rather than reading somebody else's wine. An equality check
 * against a `tenant_id` the same query returned would only restate what RLS
 * already guaranteed; what makes this safe is that the id in the message came
 * out of an `outbox` row whose `WITH CHECK` is tenant-only, so it cannot name
 * a tenant the writer was not in.
 *
 * `FOR UPDATE` on the product row: two deliveries of the same message can
 * arrive at once, and without the lock both read `PENDING`, both embed, and
 * both write — paying twice and racing on the state column.
 */
export const readProductForEmbedding = async (
  tx: DbTransaction,
  productId: string,
): Promise<EmbeddableRow | undefined> => {
  const rows = await tx
    .select({
      id: products.id,
      tenantId: products.tenantId,
      status: products.status,
      embeddingState: products.embeddingState,
      embeddingError: products.embeddingError,
      embeddingAttempts: products.embeddingAttempts,
      name: products.name,
      producer: products.producer,
      vintage: products.vintage,
      wineType: products.wineType,
      grapeVarieties: products.grapeVarieties,
      region: products.region,
      denomination: products.denomination,
      styleTags: products.styleTags,
      tastingNotes: products.tastingNotes,
      foodPairings: products.foodPairings,
      alcoholPct: products.alcoholPct,
      priceCents: products.priceCents,
    })
    .from(products)
    .where(eq(products.id, productId))
    .for('update')
    .limit(1);

  const row = rows[0];
  if (row === undefined) return undefined;

  /*
   * A separate statement rather than a join, because the join would have to be
   * a LEFT JOIN against a table the lock above does not cover — and reading it
   * separately inside the same transaction is both simpler and no less
   * consistent.
   */
  const stored = await tx
    .select({ contentHash: productEmbeddings.contentHash })
    .from(productEmbeddings)
    .where(
      and(
        eq(productEmbeddings.productId, productId),
        eq(productEmbeddings.chunkIdx, EMBEDDING_CHUNK),
      ),
    )
    .limit(1);

  return { ...row, embeddedHash: stored[0]?.contentHash ?? null };
};

export interface StoredEmbedding {
  readonly tenantId: string;
  readonly productId: string;
  readonly contentHash: string;
  readonly embedding: readonly number[];
  readonly model: string;
}

/**
 * Writes the vector, replacing whatever was there.
 *
 * **An upsert rather than an insert, and the schema comment says why**:
 * appending would double a product's vectors and skew every ranking it appears
 * in. The unique constraint on `(tenant_id, product_id, chunk_idx)` is the
 * conflict target, so a redelivered message overwrites its own row instead of
 * raising.
 *
 * `content_hash` is written *here*, beside the vector it describes, which is
 * what makes it answer "what was this built from" rather than "what did the
 * row look like when somebody last saved it".
 */
export const upsertEmbedding = async (
  tx: DbTransaction,
  stored: StoredEmbedding,
): Promise<void> => {
  await tx
    .insert(productEmbeddings)
    .values({
      tenantId: stored.tenantId,
      productId: stored.productId,
      chunkIdx: EMBEDDING_CHUNK,
      contentHash: stored.contentHash,
      embedding: [...stored.embedding],
      model: stored.model,
    })
    .onConflictDoUpdate({
      target: [productEmbeddings.tenantId, productEmbeddings.productId, productEmbeddings.chunkIdx],
      set: {
        contentHash: stored.contentHash,
        embedding: [...stored.embedding],
        model: stored.model,
        createdAt: sql`now()`,
      },
    });
};

export interface EmbeddingStatusWrite {
  readonly state: EmbeddingState;
  readonly error: string | null;
  readonly attempts: number;
}

/**
 * Records where a product now sits in the pipeline.
 *
 * The three columns move together because they are one fact: a `FAILED` row
 * with last week's error, or an `INDEXED` row still carrying one, tells an
 * operator something untrue — and P1-50's triage reads exactly these. The
 * decision about what the next state *is* belongs to `nextEmbeddingStatus` in
 * `packages/core`; this only writes what it was handed.
 */
export const writeEmbeddingStatus = async (
  tx: DbTransaction,
  productId: string,
  status: EmbeddingStatusWrite,
): Promise<void> => {
  await tx
    .update(products)
    .set({
      embeddingState: status.state,
      embeddingError: status.error,
      embeddingAttempts: status.attempts,
      /*
       * `updated_at` is deliberately not touched. It means "when did the
       * seller last change this wine", and a background job moving it would
       * make the catalogue's sort-by-recently-edited useless the first time a
       * bulk re-index ran.
       */
    })
    .where(eq(products.id, productId));
};
