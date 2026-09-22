import { createHash } from 'node:crypto';

import {
  completenessOf,
  MAX_CANDIDATES,
  pairingSystemPrompt,
  type Completeness,
  type EmbeddingProvider,
  type ScorableProduct,
} from '@catalogorosso/core';
import type { FusedCandidate, ProductRow, StockStatus } from '@catalogorosso/db';

import { retrieve, SIMULATION_LIMIT } from './retrieval.js';

/**
 * The retrieval diagnostic (P2-37, §4.4).
 *
 * **"The widget recommends Moscato when people ask about steak" is the support
 * ticket this product will receive most**, and without this it is undebuggable:
 * reproducing it through the live widget inflates the tenant's usage counters,
 * pollutes their analytics with ghost conversations, and still shows only the
 * answer rather than the reasoning.
 *
 * **It runs the real path**, P2-17 through P2-22 — the same embedding, the same
 * fused statement, the same filter, the same cap. A sandbox that ran a
 * *similar* pipeline would answer questions about itself.
 *
 * **It writes nothing.** No `usage_events`, no `widget_events`, no
 * conversation. A merchant clicking it twenty times while debugging must not
 * move a number that anyone later reads as traffic.
 *
 * **Retrieval only.** Most complaints are retrieval problems, generation costs
 * money, and this is the endpoint a frustrated merchant clicks repeatedly. The
 * row's opt-in generation flag waits for P2-31's usage writer, because billing
 * a call this endpoint makes needs somewhere to write the bill.
 */

/**
 * Why a retrieval came back with nothing a visitor could be shown.
 *
 * §2.4's `ZERO_RESULTS` panel is why this is three values rather than a
 * boolean: "your catalogue has no answer to this" and "your answers are all
 * sold out" are different problems with different fixes, and a seller can act
 * on both. Reporting only that the list was empty tells them nothing.
 */
export type ZeroResultKind = 'no_matches' | 'filtered_out' | 'out_of_stock_only';

/** Why a candidate did not reach the prompt. `null` means it did. */
export type ExclusionReason = 'stock' | 'price' | 'cap';

export interface SimulatedCandidate {
  readonly productId: string;
  readonly name: string;
  readonly vectorRank: number | null;
  /**
   * Cosine similarity, `1 - distance`, or null where the vector branch missed
   * it. Shown as a similarity because that is how the number reads: one is
   * identical, nought is unrelated.
   */
  readonly vectorScore: number | null;
  readonly lexicalRank: number | null;
  /** `Σ 1/(k + rank)`. The number that decided the order. */
  readonly rrfScore: number;
  readonly completeness: Completeness;
  readonly stockStatus: StockStatus;
  readonly priceCents: number;
  /** Whether this wine reached the prompt. */
  readonly included: boolean;
  /**
   * Why it did not, when it did not.
   *
   * **The row asks only for `included`, and this is the addition that makes it
   * answer the ticket.** "Retrieved at rank 11 and cut" and "retrieved at rank
   * 2 and sold out" are the same `false`, and they are the two explanations a
   * merchant is choosing between.
   */
  readonly excludedBy: ExclusionReason | null;
}

export interface RetrievalSimulation {
  readonly candidates: readonly SimulatedCandidate[];
  /** How many survived filtering, before the cap (P2-22). §2.4 reads this. */
  readonly preCapCount: number;
  readonly zeroResultKind: ZeroResultKind | null;
  readonly timings: { readonly embedMs: number; readonly searchMs: number };
  /**
   * A hash of the system prefix that *would* be sent, never the prefix itself.
   *
   * **Returning the assembled prompt would publish our instructions to every
   * tenant**, which is a §3.7 boundary rather than a formatting preference. A
   * hash lets support confirm which version ran without disclosing a word of
   * it, which is the whole of what support needs it for.
   */
  readonly systemPromptHash: string;
}

export interface SimulateRetrievalCommand {
  readonly tenantId: string;
  /** The question a merchant is reproducing. Embedded verbatim, like a visitor's. */
  readonly query: string;
  /** A price ceiling in minor units, structured — never inferred here (P2-21). */
  readonly maxPriceCents?: number | undefined;
  /** The cap under test. P1-46 sweeps it; a merchant leaves it alone. */
  readonly cap?: number | undefined;
}

export interface RagPort {
  simulate(command: SimulateRetrievalCommand): Promise<RetrievalSimulation>;
}

export interface RagPortOptions {
  /** The query embedder, already held to the index by `assertQueryProviderMatchesIndex` (P2-17). */
  readonly provider: EmbeddingProvider;
  /** Monotonic milliseconds. Injected so a test can assert a timing without sleeping. */
  readonly now?: () => number;
}

/**
 * The scorable fields, off the row.
 *
 * Named rather than spread. The row carries a price, a stock status and a
 * tenant id, and a spread would hand all of them to a scorer whose field list
 * is a product decision — adding a column would silently change every score.
 */
const scorable = (row: ProductRow | undefined): ScorableProduct => ({
  foodPairings: row?.foodPairings,
  tastingNotes: row?.tastingNotes,
  grapeVarieties: row?.grapeVarieties,
  region: row?.region,
  denomination: row?.denomination,
  producer: row?.producer,
  styleTags: row?.styleTags,
  vintage: row?.vintage,
  alcoholPct: row?.alcoholPct,
});

/**
 * Why nothing reached the prompt, or null because something did.
 *
 * Read off the three stages rather than from the final list, because the final
 * list cannot tell them apart: it is empty in the first two cases and full of
 * unbuyable wines in the third.
 */
const zeroResultOf = (
  fused: number,
  kept: number,
  outOfStockOnly: boolean,
): ZeroResultKind | null => {
  if (fused === 0) return 'no_matches';
  if (kept === 0) return 'filtered_out';

  return outOfStockOnly ? 'out_of_stock_only' : null;
};

export const createRagPort = ({
  provider,
  now = () => performance.now(),
}: RagPortOptions): RagPort => ({
  async simulate({ tenantId, query, maxPriceCents, cap = MAX_CANDIDATES }) {
    /*
     * **The same function the chat route calls**, which is this endpoint's one
     * real claim: a sandbox running its own pipeline would answer questions
     * about itself rather than about the answer a merchant is complaining
     * about (`src/retrieval.ts`).
     */
    const { fused, rows, filtered, capped, embedMs, searchMs } = await retrieve(
      { provider, now },
      { tenantId, query, maxPriceCents, cap, limit: SIMULATION_LIMIT },
    );

    const kept = new Set(capped.candidates.map((candidate) => candidate.productId));
    const survivedFilter = new Set(filtered.candidates.map((candidate) => candidate.productId));
    const named = new Map(rows.map((row) => [row.id, row]));

    const why = (candidate: FusedCandidate): ExclusionReason | null => {
      if (kept.has(candidate.productId)) return null;
      if (survivedFilter.has(candidate.productId)) return 'cap';

      /*
       * The ceiling is named first because it is applied first (P2-21). A wine
       * that is both sold out and over budget was dropped by the price rule,
       * and answering "stock" would send a merchant to restock a bottle the
       * visitor had already priced out.
       */
      return maxPriceCents !== undefined && candidate.priceCents > maxPriceCents
        ? 'price'
        : 'stock';
    };

    return {
      candidates: fused.map((candidate) => {
        const row = named.get(candidate.productId);

        return {
          productId: candidate.productId,
          name: row?.name ?? '',
          vectorRank: candidate.vectorRank,
          vectorScore: candidate.vectorDistance === null ? null : 1 - candidate.vectorDistance,
          lexicalRank: candidate.lexicalRank,
          rrfScore: candidate.score,
          completeness: completenessOf(scorable(row)),
          stockStatus: candidate.stockStatus,
          priceCents: candidate.priceCents,
          included: kept.has(candidate.productId),
          excludedBy: why(candidate),
        };
      }),
      preCapCount: capped.consideredCount,
      zeroResultKind: zeroResultOf(fused.length, capped.candidates.length, filtered.outOfStockOnly),
      timings: { embedMs, searchMs },
      /*
       * Truncated, because it is an identifier rather than a commitment: it
       * exists so two support tickets can be compared, and a full digest would
       * invite somebody to treat it as one.
       */
      systemPromptHash: createHash('sha256')
        .update(pairingSystemPrompt())
        .digest('hex')
        .slice(0, 16),
    };
  },
});

/**
 * The absent-port stub, on the same terms as `unconfiguredProducts`.
 *
 * Throws rather than answering plausibly. A diagnostic wired to nothing that
 * returned an empty candidate list would be read as "retrieval found nothing",
 * which is the one conclusion this endpoint exists to make trustworthy.
 */
export class RagPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No RAG port was supplied to createApp, so retrieval cannot be simulated. This is ' +
        'a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'RagPortNotConfiguredError';
  }
}

export const unconfiguredRag: RagPort = {
  simulate() {
    throw new RagPortNotConfiguredError();
  },
};
