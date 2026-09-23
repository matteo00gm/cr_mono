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

/** How many wines the lexical branch offers the fusion (§4.4). */
export const LEXICAL_CANDIDATE_LIMIT = 40;

export interface LexicalCandidate {
  readonly productId: string;
  /** `ts_rank_cd`, or trigram similarity on the fallback. Higher ranks first. */
  readonly rank: number;
  /** Which branch found it, so a caller can tell a match from a guess. */
  readonly matched: 'text' | 'similar';
}

export interface LexicalSearchRequest {
  /** The visitor's question, as they typed it. */
  readonly query: string;
  readonly limit?: number | undefined;
}

/**
 * The words a grape arm compares against, as one Postgres array literal.
 *
 * **A literal rather than a bound array.** Drizzle expands a JavaScript array
 * into one placeholder per element — `any(($2, $3)::text[])` — which is a record
 * cast and fails. The words are letters and digits by construction, having been
 * split on everything else, so quoting them needs no escaping.
 *
 * Lowercased, so `nebbiolo` answers a wine whose grape is stored as `Nebbiolo`.
 */
const termsOf = (query: string): string => {
  const words = new Set(
    query
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((word) => word !== ''),
  );

  return `{${[...words].map((word) => `"${word}"`).join(',')}}`;
};

/**
 * The wines whose words match the question (§4.4).
 *
 * **`websearch_to_tsquery`, not `to_tsquery`.** A visitor types quotes, `and`,
 * a stray `!`, an emoji; `to_tsquery` raises a syntax error on all of it and the
 * chat request fails. `websearch_to_tsquery` parses the same input the way a
 * search box does and never throws, which is the only acceptable behaviour for
 * text somebody typed.
 *
 * **The grape arm is a containment query, not text.** P1-07 deliberately left
 * `grape_varieties` out of `search_tsv` — it is an array, and a wine made from
 * Nebbiolo does not say "Nebbiolo" in its description. Matching it needs the
 * array, and the row asks lexical search to find by grape.
 *
 * **The trigram fallback runs only when nothing matched**, which is what makes
 * it a fallback rather than a second opinion: `%` is a similarity threshold, so
 * on a query that already matched it would add wines that merely look like the
 * words. A misspelled producer is a large share of real questions, and it is
 * the case where a guess is better than nothing.
 */
export const lexicalSearch = async (
  tx: DbTransaction,
  { query, limit = LEXICAL_CANDIDATE_LIMIT }: LexicalSearchRequest,
): Promise<LexicalCandidate[]> => {
  const terms = termsOf(query);

  const matched = await tx.execute(sql`
    select p.id as product_id, ts_rank_cd(p.search_tsv, q) as rank
    from products p, websearch_to_tsquery('italian', ${query}) q
    where p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and p.status = 'ACTIVE'
      and (
        p.search_tsv @@ q
        or exists (
          select 1 from unnest(p.grape_varieties) g where lower(g) = any(${terms}::text[])
        )
      )
    order by p.id
    limit ${limit}
  `);

  const rows = [...matched];

  if (rows.length > 0) {
    return rows.map((row) => {
      const { product_id: productId, rank } = row as { product_id: string; rank: number | string };

      return { productId, rank: Number(rank), matched: 'text' as const };
    });
  }

  const similar = await tx.execute(sql`
    select p.id as product_id,
           greatest(
             similarity(p.name, ${query}),
             similarity(coalesce(p.producer, ''), ${query})
           ) as rank
    from products p
    where p.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and p.status = 'ACTIVE'
      and (p.name % ${query} or coalesce(p.producer, '') % ${query})
    order by rank desc, p.id
    limit ${limit}
  `);

  return [...similar].map((row) => {
    const { product_id: productId, rank } = row as { product_id: string; rank: number | string };

    return { productId, rank: Number(rank), matched: 'similar' as const };
  });
};
