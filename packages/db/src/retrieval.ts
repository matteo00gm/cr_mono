import { sql } from 'drizzle-orm';

import { activeEmbeddingVersionFilter } from './embeddings.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Retrieval against the catalogue (P2-18, §4.4).
 *
 * **In `packages/db` rather than `packages/core/src/rag/` where the row puts
 * it**, on this package's established terms: a statement lives where queries
 * live, so no domain module imports a driver (P0-09) — the same deviation the
 * limiter, the audit insert and the security-event writer record. What is
 * *pure* about retrieval — how two rankings fuse, what survives a filter, how
 * many candidates a prompt may carry — stays in `packages/core`.
 *
 * **Every query here takes the caller's transaction**, so retrieval runs inside
 * one `withTenant` (P0-19) and one connection. P2-20 explains at length why
 * that matters: two searches issued concurrently on one `postgres-js`
 * connection serialise anyway, and making them genuinely parallel would mean
 * two transactions per chat request against a pool of one or two.
 */

/**
 * How many wines the vector branch offers the fusion (§4.4).
 *
 * A parameter rather than a literal in the SQL, so P1-46's eval can sweep it
 * without editing a statement.
 */
export const VECTOR_CANDIDATE_LIMIT = 40;

export interface VectorCandidate {
  readonly productId: string;
  /** Cosine distance: 0 is identical, 2 is opposite. Lower ranks first. */
  readonly distance: number;
}

export interface VectorSearchRequest {
  /** The query vector, from `embedQuery` (P2-17). */
  readonly vector: readonly number[];
  readonly limit?: number | undefined;
}

/**
 * The nearest wines to a query vector, best chunk per wine.
 *
 * **`::halfvec`, never `::vector`.** The column is `halfvec(1024)` and the index
 * is `halfvec_cosine_ops`; a `vector` cast compares against a different type, so
 * the index cannot serve it and Postgres silently falls back — the exact failure
 * P1-49's migration comment warns about.
 *
 * **The tenant predicate is written out even though RLS enforces it.** Belt and
 * braces, and the planner gets a usable predicate rather than inferring one from
 * a policy.
 *
 * **`distinct on (product_id)`** keeps a wine that is stored as several chunks
 * from occupying several of the forty places with the same bottle.
 *
 * **The version filter is P1-49's**: a tenant mid-migration has two generations
 * of vectors, and mixing them ranks one model's distances against another's.
 */
export const vectorSearch = async (
  tx: DbTransaction,
  { vector, limit = VECTOR_CANDIDATE_LIMIT }: VectorSearchRequest,
): Promise<VectorCandidate[]> => {
  const literal = JSON.stringify([...vector]);

  const rows = await tx.execute(sql`
    select product_id, distance
    from (
      select distinct on (e.product_id)
             e.product_id,
             (e.embedding <=> ${literal}::halfvec) as distance
      from product_embeddings e
      join products p on p.id = e.product_id and p.tenant_id = e.tenant_id
      where e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and p.status = 'ACTIVE'
        and ${activeEmbeddingVersionFilter('e')}
      order by e.product_id, distance
    ) best
    order by distance, product_id
    limit ${limit}
  `);

  return [...rows].map((row) => {
    const { product_id: productId, distance } = row as {
      product_id: string;
      distance: number | string;
    };

    return { productId, distance: Number(distance) };
  });
};
