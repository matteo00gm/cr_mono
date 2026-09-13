import { eq } from 'drizzle-orm';

import { products } from './schema/products.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Where a product sits in the embedding pipeline, and the one statement that
 * moves it (P1-38).
 *
 * **Its own module because three callers need it and two of them cannot see
 * each other.** The worker writes this after embedding (`embeddings.ts`), the
 * catalogue filters on it (`products-read.ts`), and a reindex applies a
 * transition to it (`products.ts`) — and `products-read.ts` already imports
 * `ProductRow` from `products.ts`, so putting the write beside either of them
 * closes a cycle. The `no-circular` boundary rule caught exactly that, on the
 * first arrangement of P1-39.
 *
 * This module imports the schema and nothing else, which is what makes it
 * importable from all three.
 */

/** Where a row sits in the embedding pipeline. */
export const EMBEDDING_STATES = ['PENDING', 'INDEXED', 'FAILED', 'STALE'] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

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
       * **`updated_at` is not named here and does not move**, which took a
       * migration to make true. P0-22's shared trigger stamps every UPDATE, so
       * until `0038` a bulk re-index moved every wine to the top of "recently
       * edited" — a sort P1-06 offers sellers — without anybody having touched
       * one. `products` now has its own trigger that ignores exactly the three
       * columns below, so the column keeps meaning what a seller reads it as.
       *
       * Which is why these three are written *alone*. Adding a fourth column to
       * this `set` would be an edit as far as the trigger is concerned, and the
       * sort would start lying again.
       */
    })
    .where(eq(products.id, productId));
};
