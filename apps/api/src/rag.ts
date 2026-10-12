import { createHash } from 'node:crypto';

import {
  completenessOf,
  ConflictError,
  isServed,
  MAX_CANDIDATES,
  NotFoundError,
  pairingSystemPrompt,
  RateLimitedError,
  SANDBOX_ANSWER_WINDOW_SEC,
  SANDBOX_ANSWERS_PER_MINUTE,
  SANDBOX_NOT_SERVED,
  SANDBOX_QUOTA_EXCEEDED,
  SANDBOX_TOO_FAST,
  sandboxAnswerLimitKey,
  type Completeness,
  type EmbeddingProvider,
  type PairingOutcome,
  type ScorableProduct,
} from '@catalogorosso/core';
import {
  readServiceState,
  withTenant,
  type FusedCandidate,
  type ProductRow,
  type ServiceState,
  type StockStatus,
} from '@catalogorosso/db';
import type { RateLimiter } from '@catalogorosso/security';

import { QuotaExceededError, type ChatPort } from './chat.js';
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
 * money, and this is the endpoint a frustrated merchant clicks repeatedly.
 *
 * **An answer is a second thing, asked for on its own** (`answer`, P2-37b). It
 * is a real turn through the chat port and is billed as one, so none of the
 * three sentences above is true of it — which is why it is another method on
 * another route, and not a flag that would make this one sometimes cost money.
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

/** A wine the sommelier recommended, as the seller is shown it. */
export interface SandboxRecommendation {
  readonly productId: string;
  /** From our own row, like every field of a card (P2-25): the model named an id. */
  readonly name: string;
  /** The model's own words for why. */
  readonly reason: string;
  readonly confidence: number;
}

/** One answer, whole (P2-37b). */
export interface SandboxAnswer {
  readonly reply: string;
  readonly recommendations: readonly SandboxRecommendation[];
  /**
   * How the turn ended. A reply with no wines under it is explained by this:
   * the model declined, or failed the schema twice, or the provider raised.
   */
  readonly outcome: PairingOutcome;
}

export interface AnswerInSandboxCommand {
  readonly tenantId: string;
  /** The question, as a visitor would type it. */
  readonly query: string;
  /** Stops generation — and so the tokens billed — when the request goes away. */
  readonly signal: AbortSignal;
}

export interface RagPort {
  simulate(command: SimulateRetrievalCommand): Promise<RetrievalSimulation>;
  /** One real answer, billed as one of the winery's messages (P2-37b). */
  answer(command: AnswerInSandboxCommand): Promise<SandboxAnswer>;
}

/** What answering needs beyond retrieval. All of it or none: there is no half of a billed call. */
export interface SandboxAnswering {
  /** The port a visitor's question goes through — the same one, not a second pipeline. */
  readonly chat: ChatPort;
  /** Required, not optional: a model call nothing counts is the thing this row exists to prevent. */
  readonly limiter: RateLimiter;
  /** The winery as the widget's own gates read it, in its own scope. */
  readonly readService?: ((tenantId: string) => Promise<ServiceState | undefined>) | undefined;
  /** The clock a trial's end is read against. */
  readonly clock?: (() => Date) | undefined;
}

export interface RagPortOptions {
  /** The query embedder, already held to the index by `assertQueryProviderMatchesIndex` (P2-17). */
  readonly provider: EmbeddingProvider;
  /** Monotonic milliseconds. Injected so a test can assert a timing without sleeping. */
  readonly now?: () => number;
  /** Absent, `answer` is a wiring error and `simulate` works as it always did. */
  readonly answering?: SandboxAnswering | undefined;
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
  answering,
}: RagPortOptions): RagPort => ({
  async answer({ tenantId, query, signal }) {
    if (answering === undefined) throw new SandboxAnsweringNotConfiguredError();

    const {
      chat,
      limiter,
      readService = (id) => withTenant(id, readServiceState),
      clock = () => new Date(),
    } = answering;

    /*
     * **Counted first, before the winery is even read.** Per winery rather
     * than per member: the bill is the winery's, and two members with one
     * script each are still one winery's month being spent.
     */
    const allowance = await limiter.check([
      {
        key: sandboxAnswerLimitKey(tenantId),
        limit: SANDBOX_ANSWERS_PER_MINUTE,
        windowSec: SANDBOX_ANSWER_WINDOW_SEC,
      },
    ]);

    if (!allowance.allowed) throw new RateLimitedError(SANDBOX_TOO_FAST);

    const service = await readService(tenantId);

    if (service === undefined) throw new NotFoundError();

    /*
     * **Answered here exactly when it would be answered on the winery's site**
     * (P5-05a). The sandbox is billed against a plan or a running trial, and a
     * winery with neither has nothing to bill: one that never verified a
     * domain would otherwise have a model to talk to for nothing, for ever.
     */
    if (!isServed(service, clock())) throw new ConflictError(SANDBOX_NOT_SERVED);

    let reply = '';
    let outcome: PairingOutcome = 'provider_error';
    const recommendations: SandboxRecommendation[] = [];

    try {
      /*
       * **The chat port, with nobody behind the turn**: the monthly gate, the
       * redaction, retrieval, the prompt, both boundaries on the stream and
       * the bill are the widget's own, and no conversation is kept.
       */
      const turn = chat.answer(
        {
          tenant: {
            tenantId,
            ...service,
            /* Neither is read on this path: no session is minted, no origin is limited. */
            turnstile: false,
            originKind: 'production',
          },
          visitor: null,
          message: query,
          signal,
        },
        (report) => {
          outcome = report.outcome;
        },
      );

      for await (const event of turn) {
        if (event.type === 'text') reply += event.delta;

        if (event.type === 'recommendations') {
          recommendations.push(
            ...event.items.map((item) => ({
              productId: item.productId,
              name: item.product.name,
              reason: item.reason,
              confidence: item.confidence,
            })),
          );
        }
      }
    } catch (error) {
      /* Refused before anything was spent, as a visitor's would be — and told to somebody who can act. */
      if (error instanceof QuotaExceededError) throw new ConflictError(SANDBOX_QUOTA_EXCEEDED);

      throw error;
    }

    return { reply, recommendations, outcome };
  },

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

/** Retrieval is wired and answering is not: a deployment with no chat port handed to this one. */
export class SandboxAnsweringNotConfiguredError extends Error {
  constructor() {
    super(
      'The RAG port was built without `answering`, so the sandbox cannot generate an answer. ' +
        'This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'SandboxAnsweringNotConfiguredError';
  }
}

export const unconfiguredRag: RagPort = {
  simulate() {
    throw new RagPortNotConfiguredError();
  },
  answer() {
    throw new RagPortNotConfiguredError();
  },
};
