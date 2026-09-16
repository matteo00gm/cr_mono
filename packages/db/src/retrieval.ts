import { sql, type SQL } from 'drizzle-orm';

import { activeEmbeddingVersionFilter } from './embeddings.js';
import type { StockStatus } from './products-read.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Retrieval against the catalogue (P2-18 to P2-20, §4.4).
 *
 * **In `packages/db` rather than `packages/core/src/rag/` where the rows put
 * it**, on this package's established terms: a statement lives where queries
 * live, so no domain module imports a driver (P0-09) — the same deviation the
 * limiter, the audit insert and the security-event writer record. What is
 * *pure* about retrieval — what survives a filter, how many candidates a prompt
 * may carry — stays in `packages/core`.
 *
 * **Every query here takes the caller's transaction**, so a whole retrieval runs
 * inside one `withTenant` (P0-19) on one connection. P2-20 explains at length
 * why that matters.
 *
 * **The branches are written once and composed.** The fused query (P2-20) needs
 * the same rows as the standalone branches, and a second copy of a tenant
 * predicate or a status filter is how one copy comes to be missing it — the
 * failure would be a wine from another winery, or an archived one, reaching a
 * visitor through the path that happens to be wired.
 */

/** The tenant a request resolved, read from the setting `withTenant` sets. */
const tenantScope = sql`nullif(current_setting('app.tenant_id', true), '')::uuid`;

/** A wine a seller still lists. Archived ones are never retrievable (P1-05). */
const listedWine = sql`p.status = 'ACTIVE'`;

/**
 * A grape the question names.
 *
 * P1-07 deliberately kept `grape_varieties` out of `search_tsv`: it is an array,
 * and a wine made from Nebbiolo does not say "Nebbiolo" in its description.
 * Compared lowercased, so `nebbiolo` answers a wine stored as `Nebbiolo`.
 */
const grapeMatches = (terms: string): SQL =>
  sql`exists (select 1 from unnest(p.grape_varieties) g where lower(g) = any(${terms}::text[]))`;

/** A name or producer that merely looks like the question — the misspelling case. */
const looksLike = (query: string): SQL =>
  sql`(p.name % ${query} or coalesce(p.producer, '') % ${query})`;

/**
 * How many wines the vector branch offers the fusion (§4.4).
 *
 * A parameter rather than a literal in the SQL, so P1-46's eval can sweep it
 * without editing a statement.
 */
export const VECTOR_CANDIDATE_LIMIT = 40;

/** How many wines the lexical branch offers the fusion (§4.4). */
export const LEXICAL_CANDIDATE_LIMIT = 40;

/**
 * The nearest wines to a query vector, best chunk per wine.
 *
 * **`::halfvec`, never `::vector`.** The column is `halfvec(1024)` and the index
 * is `halfvec_cosine_ops`; a `vector` cast compares against a different type, so
 * the index cannot serve it and Postgres silently falls back — the exact failure
 * migration 0011 warns about in its own comment.
 *
 * **The tenant predicate is written out even though RLS enforces it.** Belt and
 * braces, and the planner gets a usable predicate rather than inferring one from
 * a policy.
 *
 * **`distinct on (product_id)`** keeps a wine stored as several chunks from
 * occupying several of the forty places with the same bottle.
 *
 * **The version filter is P1-49's**: a tenant mid-migration has two generations
 * of vectors, and mixing them ranks one model's distances against another's.
 */
const nearestWines = (literal: string, limit: number): SQL => sql`
  select product_id, distance
  from (
    select distinct on (e.product_id)
           e.product_id,
           (e.embedding <=> ${literal}::halfvec) as distance
    from product_embeddings e
    join products p on p.id = e.product_id and p.tenant_id = e.tenant_id
    where e.tenant_id = ${tenantScope}
      and ${listedWine}
      and ${activeEmbeddingVersionFilter('e')}
    order by e.product_id, distance
  ) best
  order by distance, product_id
  limit ${limit}
`;

/**
 * The wines whose words match the question.
 *
 * **`websearch_to_tsquery`, not `to_tsquery`.** A visitor types quotes, `and`,
 * a stray `!`, an emoji; `to_tsquery` raises a syntax error on all of it and the
 * chat request fails. `websearch_to_tsquery` parses the same input the way a
 * search box does and never throws, which is the only acceptable behaviour for
 * text somebody typed.
 *
 * A word match outranks a grape match, because the branch hands fusion a *rank*
 * and that order is the whole of its signal.
 */
const wordMatches = (query: string, terms: string, limit: number): SQL => sql`
  select p.id as product_id,
         (p.search_tsv @@ q) as by_words,
         ts_rank_cd(p.search_tsv, q) as rank_score
  from products p, websearch_to_tsquery('italian', ${query}) q
  where p.tenant_id = ${tenantScope}
    and ${listedWine}
    and (p.search_tsv @@ q or ${grapeMatches(terms)})
  order by by_words desc, rank_score desc, p.id
  limit ${limit}
`;

/** The misspelling branch, scored by how close the spelling came. */
const spellingMatches = (query: string, limit: number, gate: SQL): SQL => sql`
  select p.id as product_id,
         true as by_words,
         greatest(
           similarity(p.name, ${query}),
           similarity(coalesce(p.producer, ''), ${query})
         ) as rank_score
  from products p
  where ${gate}
    and p.tenant_id = ${tenantScope}
    and ${listedWine}
    and ${looksLike(query)}
  order by rank_score desc, p.id
  limit ${limit}
`;

/**
 * The words a grape arm compares against, as one Postgres array literal.
 *
 * **A literal rather than a bound array.** Drizzle expands a JavaScript array
 * into one placeholder per element — `any(($2, $3)::text[])` — which is a record
 * cast and fails. The words are letters and digits by construction, having been
 * split on everything else, so quoting them needs no escaping.
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

/** The vector branch on its own (P2-18), which P2-37's sandbox reports separately. */
export const vectorSearch = async (
  tx: DbTransaction,
  { vector, limit = VECTOR_CANDIDATE_LIMIT }: VectorSearchRequest,
): Promise<VectorCandidate[]> => {
  const rows = await tx.execute(nearestWines(JSON.stringify([...vector]), limit));

  return [...rows].map((row) => {
    const { product_id: productId, distance } = row as {
      product_id: string;
      distance: number | string;
    };

    return { productId, distance: Number(distance) };
  });
};

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
 * The lexical branch on its own (P2-19).
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
  const matched = await tx.execute(sql`
    select product_id, by_words, rank_score
    from (${wordMatches(query, termsOf(query), limit)}) words
    order by by_words desc, rank_score desc, product_id
  `);

  const rows = [...matched];

  if (rows.length > 0) {
    return rows.map((row) => {
      const { product_id: productId, rank_score: rank } = row as {
        product_id: string;
        rank_score: number | string;
      };

      return { productId, rank: Number(rank), matched: 'text' as const };
    });
  }

  const guessed = await tx.execute(sql`
    select product_id, rank_score
    from (${spellingMatches(query, limit, sql`true`)}) fuzzy
    order by rank_score desc, product_id
  `);

  return [...guessed].map((row) => {
    const { product_id: productId, rank_score: rank } = row as {
      product_id: string;
      rank_score: number | string;
    };

    return { productId, rank: Number(rank), matched: 'similar' as const };
  });
};

/**
 * Reciprocal rank fusion's constant (§4.4), and the reason RRF was chosen.
 *
 * The score is `Σ 1/(k + rank)`, which reads *ranks* rather than scores — so a
 * cosine distance and a `ts_rank_cd` never have to be made comparable, which
 * they are not. A weighted blend would need a normalisation with no principled
 * value, and would quietly change meaning as either scale drifts.
 *
 * Bound as a parameter so P1-46's eval can sweep it.
 */
export const RRF_K = 60;

/** How many fused candidates a caller gets, before filtering (P2-21) and the cap (P2-22). */
export const FUSED_CANDIDATE_LIMIT = 40;

export interface FusedCandidate {
  readonly productId: string;
  /** `Σ 1/(k + rank)` over the branches that found it. Higher ranks first. */
  readonly score: number;
  /** Where each branch placed it, or null where that branch missed it. P2-37 shows these. */
  readonly vectorRank: number | null;
  readonly lexicalRank: number | null;
  /**
   * Cosine distance to the query vector, or null where the vector branch missed
   * it. Nought is identical and two is opposite, so a similarity is `1 - d`.
   *
   * Carried for P2-37's sandbox, which is the one caller that has to explain a
   * ranking rather than act on it. RRF reads ranks, so nothing here depends on
   * this number — which is exactly why it has to come from the statement that
   * computed it rather than be recomputed later against a vector that may have
   * been re-indexed in between.
   */
  readonly vectorDistance: number | null;
  /**
   * What P2-21 filters on, read in the statement that found the wine.
   *
   * Carried here rather than fetched afterwards because the filter is pure and
   * a second trip for two columns of rows we already have is a second trip.
   */
  readonly stockStatus: StockStatus;
  /** Minor units, in the tenant's currency. */
  readonly priceCents: number;
}

export interface FusedSearchRequest {
  readonly vector: readonly number[];
  readonly query: string;
  readonly limit?: number | undefined;
  readonly vectorLimit?: number | undefined;
  readonly lexicalLimit?: number | undefined;
  readonly k?: number | undefined;
}

/**
 * Both branches, fused, in **one statement** (P2-20).
 *
 * **One statement, and the row's correction is the reason.** An earlier draft
 * ran the two searches under `Promise.all`. That is wrong twice over: both need
 * the same `withTenant` transaction to have a tenant at all, and two queries
 * issued concurrently on one `postgres-js` connection serialise on it anyway —
 * so the parallelism is imaginary while looking real. Making it genuine would
 * mean two transactions per chat request against a pool of one or two, which at
 * a pool of one deadlocks: the request holds the only connection and waits for
 * a second that only it could release.
 *
 * **The `FULL OUTER JOIN` is what handles "found by one branch only"**, with no
 * special case and no missing row.
 *
 * **P2-19's fallback survives fusion** as a third CTE that contributes only when
 * the words matched nothing, so a misspelled producer still reaches the ranking.
 *
 * **Stock and price come back with the ranks** (P2-21), from a join onto the
 * products the branches already narrowed to. The filter that reads them is pure
 * and lives in `packages/core`; fetching them afterwards would be a second trip
 * for two columns of rows this statement has in hand.
 */
export const fusedSearch = async (
  tx: DbTransaction,
  {
    vector,
    query,
    limit = FUSED_CANDIDATE_LIMIT,
    vectorLimit = VECTOR_CANDIDATE_LIMIT,
    lexicalLimit = LEXICAL_CANDIDATE_LIMIT,
    k = RRF_K,
  }: FusedSearchRequest,
): Promise<FusedCandidate[]> => {
  const rows = await tx.execute(sql`
    with vec as (
      select product_id, distance,
             row_number() over (order by distance, product_id) as rank
      from (${nearestWines(JSON.stringify([...vector]), vectorLimit)}) nearest
    ),
    words as (${wordMatches(query, termsOf(query), lexicalLimit)}),
    fuzzy as (
      ${spellingMatches(query, lexicalLimit, sql`not exists (select 1 from words)`)}
    ),
    lex as (
      select product_id,
             row_number() over (order by by_words desc, rank_score desc, product_id) as rank
      from (
        select product_id, by_words, rank_score from words
        union all
        select product_id, by_words, rank_score from fuzzy
      ) merged
    )
    select product_id,
           vec.rank as vector_rank,
           lex.rank as lexical_rank,
           vec.distance as vector_distance,
           p.stock_status,
           p.price_cents,
           coalesce(1.0 / (${k} + vec.rank), 0) + coalesce(1.0 / (${k} + lex.rank), 0) as score
    from vec full outer join lex using (product_id)
    join products p on p.id = product_id and p.tenant_id = ${tenantScope}
    order by score desc, product_id
    limit ${limit}
  `);

  /*
   * `postgres-js` returns `bigint` and `numeric` as strings and `integer` as a
   * number, so the ranks and the score are coerced and the price and the distance are not.
   * The asymmetry is the driver's, not ours: a blanket `Number()` over the price
   * would be a conversion that provably cannot do anything, which both the
   * linter and P2-21's mutation run said out loud.
   */
  return [...rows].map((row) => {
    const {
      product_id: productId,
      vector_rank: vectorRank,
      lexical_rank: lexicalRank,
      vector_distance: vectorDistance,
      stock_status: stockStatus,
      price_cents: priceCents,
      score,
    } = row as {
      product_id: string;
      vector_rank: number | string | null;
      lexical_rank: number | string | null;
      vector_distance: number | null;
      stock_status: FusedCandidate['stockStatus'];
      price_cents: number;
      score: number | string;
    };

    return {
      productId,
      score: Number(score),
      vectorRank: vectorRank === null ? null : Number(vectorRank),
      lexicalRank: lexicalRank === null ? null : Number(lexicalRank),
      vectorDistance,
      stockStatus,
      priceCents,
    };
  });
};
