import type { LlmProvider, PairingChunk } from '@catalogorosso/core';

import type { EvalDataset } from './dataset.js';
import {
  CANDIDATE_LIMIT,
  firstHitRank,
  summarise,
  type EvalSummary,
  type Outcome,
  type QueryResult,
} from './metrics.js';
import type { Retriever } from './retriever.js';
import type { Judge } from './rubric.js';
import { seedCatalogs, toCandidate } from './seed.js';

export interface EvalOptions {
  readonly dataset: EvalDataset;
  readonly provider: LlmProvider;
  readonly retriever: Retriever;
  /** Scores answered queries against the rubric. Without one, `judgeScore` is null. */
  readonly judge?: Judge | undefined;
  /** Candidates handed to the model: P2-21's cap by default, and a parameter to sweep. */
  readonly limit?: number | undefined;
  readonly signal?: AbortSignal | undefined;
}

export interface EvalRun {
  readonly summary: EvalSummary;
  readonly results: readonly QueryResult[];
}

const collect = async (stream: AsyncIterable<PairingChunk>): Promise<PairingChunk[]> => {
  const chunks: PairingChunk[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
};

/** The first error wins; otherwise whether any recommendations arrived. */
const outcomeOf = (chunks: readonly PairingChunk[]): Outcome => {
  const error = chunks.find((chunk) => chunk.type === 'error');
  if (error !== undefined) return error.code;
  return chunks.some((chunk) => chunk.type === 'recommendations') ? 'answered' : 'text_only';
};

/**
 * Every query through retrieval, the provider and, if given, the judge, then
 * the run scored (P1-46).
 *
 * **One query at a time**, deliberately. Concurrency would make the run faster
 * and its provider-error rate a measurement of our own burst rather than of the
 * provider, and it would make a run's order — and so any log of it — differ
 * from the last.
 *
 * **Scoring is by what the model was given.** A recommended id maps back to a
 * SKU only through this query's candidates, so an id the model invented, or
 * one from another catalogue, counts as outside the candidates and never as a
 * hit — the same rule P2-25 enforces before a card is drawn.
 */
export const runEval = async (options: EvalOptions): Promise<EvalRun> => {
  const catalogs = seedCatalogs(options.dataset);
  const limit = options.limit ?? CANDIDATE_LIMIT;
  const signal = options.signal ?? new AbortController().signal;
  const results: QueryResult[] = [];

  for (const query of options.dataset.queries) {
    const catalog = catalogs.get(query.catalog);
    if (catalog === undefined)
      throw new Error(`${query.id} names catalog ${query.catalog}, which was not seeded`);

    const ranked = (await options.retriever(catalog, query)).slice(0, limit);
    const candidates = ranked.map(toCandidate);

    const chunks = await collect(
      options.provider.streamPairing(
        { query: query.query, locale: query.locale, candidates, history: [] },
        signal,
      ),
    );

    const outcome = outcomeOf(chunks);
    const reply = chunks.flatMap((chunk) => (chunk.type === 'text' ? [chunk.delta] : [])).join('');
    const recommendations = chunks.flatMap((chunk) =>
      chunk.type === 'recommendations' ? chunk.items : [],
    );
    const recommended = recommendations.map(
      (item) => ranked.find((seeded) => seeded.id === item.productId)?.product.sku ?? null,
    );
    const retrieved = ranked.map((seeded) => seeded.product.sku);

    results.push({
      queryId: query.id,
      kind: query.kind,
      retrieved,
      firstHitRank: firstHitRank(retrieved, query.acceptable, limit),
      outcome,
      reply,
      recommended,
      hits: recommended.filter((sku) => sku !== null && query.acceptable.includes(sku)).length,
      judge:
        options.judge !== undefined && outcome === 'answered'
          ? await options.judge({ query, candidates, reply, recommendations }, signal)
          : null,
    });
  }

  return { summary: summarise(options.provider.id, results), results };
};
