import {
  applyFilters,
  capCandidates,
  embedQuery,
  MAX_CANDIDATES,
  type CappedCandidates,
  type EmbeddingProvider,
  type FilterResult,
} from '@catalogorosso/core';
import {
  fusedSearch,
  productsByIds,
  withTenant,
  type FusedCandidate,
  type ProductRow,
} from '@catalogorosso/db';

import { withSpan } from './telemetry.js';

/**
 * The retrieval path, P2-17 through P2-22, in one place (P2-29, P2-37).
 *
 * **One pipeline, two callers.** The chat route answers a visitor with it and
 * the sandbox explains it; a second copy would mean the diagnostic answering
 * questions about itself rather than about the thing a merchant is complaining
 * about. The sandbox's whole claim is that it runs *this*.
 *
 * **One `withTenant` transaction on one connection** (P2-20). The fused search
 * and the hydration are two statements in it, not two transactions.
 */

/** How many candidates the sandbox reports on, before the cap decides which eight matter. */
export const SIMULATION_LIMIT = 40;

export interface RetrievalRequest {
  readonly tenantId: string;
  /** The visitor's question, as they wrote it. Embedded verbatim. */
  readonly query: string;
  /** A price ceiling in minor units, structured — never inferred (P2-21). */
  readonly maxPriceCents?: number | undefined;
  /** The cap under test. P1-46 sweeps it; a visitor never sets it. */
  readonly cap?: number | undefined;
  /** How many fused candidates to consider before filtering. */
  readonly limit?: number | undefined;
}

export interface Retrieved {
  /** Everything fusion returned, before P2-21 and P2-22 narrowed it. */
  readonly fused: readonly FusedCandidate[];
  /** The rows behind those ids, in fusion's order. */
  readonly rows: readonly ProductRow[];
  readonly filtered: FilterResult<FusedCandidate>;
  readonly capped: CappedCandidates<FusedCandidate>;
  readonly embedMs: number;
  readonly searchMs: number;
}

export interface RetrievalOptions {
  /** The query embedder, held to the index at startup by `assertQueryProviderMatchesIndex` (P2-17). */
  readonly provider: EmbeddingProvider;
  /** Monotonic milliseconds. Injected so a test can assert a timing without sleeping. */
  readonly now?: () => number;
}

/** Embed, fuse, filter, cap — the four the widget runs and the sandbox explains. */
export const retrieve = async (
  { provider, now = () => performance.now() }: RetrievalOptions,
  {
    tenantId,
    query,
    maxPriceCents,
    cap = MAX_CANDIDATES,
    limit = SIMULATION_LIMIT,
  }: RetrievalRequest,
): Promise<Retrieved> => {
  const embedStarted = now();
  const { vector } = await withSpan('rag.embed', () => embedQuery(provider, query), {
    'rag.model': provider.model,
  });
  const embedMs = now() - embedStarted;

  /*
   * One transaction for both reads (P2-20). The hydration is a second statement
   * rather than more columns on the fused one, because only a caller that has
   * to *show* a wine needs its whole row — the ranking itself needs ids.
   */
  const searchStarted = now();
  const { fused, rows } = await withTenant(tenantId, async (tx) => {
    /*
     * **One span, three numbers** (P7-01). The row asks for the vector branch,
     * the lexical branch and the fusion as separate spans; they are one
     * statement (P2-20), so there is one duration to report and the split is
     * in how many candidates each branch contributed.
     */
    const found = await withSpan('rag.search', async (span) => {
      const candidates = await fusedSearch(tx, { vector, query, limit });

      span.set({
        'rag.vector_hits': candidates.filter((candidate) => candidate.vectorRank !== null).length,
        'rag.lexical_hits': candidates.filter((candidate) => candidate.lexicalRank !== null).length,
        'rag.fused': candidates.length,
      });

      return candidates;
    });

    return {
      fused: found,
      rows: await withSpan('db.products', () =>
        productsByIds(
          tx,
          found.map((candidate) => candidate.productId),
        ),
      ),
    };
  });
  const searchMs = now() - searchStarted;

  /*
   * The same two functions in both callers, on the same list. A copy of either
   * rule is how a sandbox comes to disagree with the thing it exists to explain.
   */
  const filtered = applyFilters(fused, { maxPriceCents });

  return {
    fused,
    rows,
    filtered,
    capped: capCandidates(filtered.candidates, cap),
    embedMs,
    searchMs,
  };
};
