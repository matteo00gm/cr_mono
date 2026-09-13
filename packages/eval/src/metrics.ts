import type { PairingErrorCode } from '@catalogorosso/core';

import type { QueryKind } from './dataset.js';
import type { JudgeVerdict } from './rubric.js';

/** How many candidates reach the model: P2-21's cap, and the k in recall@k. */
export const CANDIDATE_LIMIT = 8;

/**
 * Above this schema-failure rate a provider is disqualified, whatever it costs.
 * A security criterion rather than a quality one: P2-25 depends on valid
 * structured output (§4.5, P1-47).
 */
export const SCHEMA_FAILURE_CEILING = 0.02;

/**
 * How one query ended. `answered` is a recommendations chunk, possibly empty;
 * `text_only` is a stream that ended with neither recommendations nor an error.
 */
export type Outcome = 'answered' | 'text_only' | PairingErrorCode;

export interface QueryResult {
  readonly queryId: string;
  readonly kind: QueryKind;
  /** Retrieved SKUs, best first, cut to the candidate limit. */
  readonly retrieved: readonly string[];
  /** The 1-based rank of the first acceptable SKU among them, or null. */
  readonly firstHitRank: number | null;
  readonly outcome: Outcome;
  /** The text the visitor would have read. */
  readonly reply: string;
  /** The SKUs recommended, in order; null for an id that was not among the candidates. */
  readonly recommended: readonly (string | null)[];
  /** How many recommendations are acceptable. */
  readonly hits: number;
  readonly judge: JudgeVerdict | null;
}

export interface EvalSummary {
  readonly provider: string;
  readonly queries: number;
  /** Answerable queries with an acceptable wine among the candidates. */
  readonly recallAt8: number;
  /** Mean reciprocal rank of the first acceptable wine over answerable queries, zero where there is none. */
  readonly mrr: number;
  /** Calls whose structured output did not validate. The number that disqualifies. */
  readonly schemaFailureRate: number;
  readonly refusalRate: number;
  readonly providerErrorRate: number;
  /** Answerable queries where at least one recommendation is acceptable. */
  readonly pairingHitRate: number;
  /** Unanswerable queries answered without recommending anything, rather than failing or confabulating. */
  readonly honestyRate: number;
  /** Recommendations naming a product that was not a candidate — each one a P2-25 drop. */
  readonly outsideCandidates: number;
  /** The mean judge score over judged answers, or null when no judge ran. */
  readonly judgeScore: number | null;
  /** Answers the judge rejected: a defensible wine for a wrong reason. */
  readonly judgeRejections: number;
}

/** The rank of the first acceptable SKU among the first `limit` retrieved, or null. */
export const firstHitRank = (
  retrieved: readonly string[],
  acceptable: readonly string[],
  limit: number = CANDIDATE_LIMIT,
): number | null => {
  const index = retrieved.slice(0, limit).findIndex((sku) => acceptable.includes(sku));
  return index === -1 ? null : index + 1;
};

/** A share of a total, and zero of nothing rather than NaN. */
const rate = (count: number, total: number): number => (total === 0 ? 0 : count / total);

/** Scores one run. Pure, so two runs' summaries can be compared as values. */
export const summarise = (provider: string, results: readonly QueryResult[]): EvalSummary => {
  const answerable = results.filter((result) => result.kind !== 'unanswerable');
  const unanswerable = results.filter((result) => result.kind === 'unanswerable');
  const ended = (outcome: Outcome) => results.filter((result) => result.outcome === outcome).length;
  const judged = results.flatMap((result) => (result.judge === null ? [] : [result.judge]));

  return {
    provider,
    queries: results.length,
    recallAt8: rate(
      answerable.filter((result) => result.firstHitRank !== null).length,
      answerable.length,
    ),
    mrr: rate(
      answerable.reduce(
        (sum, result) => sum + (result.firstHitRank === null ? 0 : 1 / result.firstHitRank),
        0,
      ),
      answerable.length,
    ),
    schemaFailureRate: rate(ended('schema_invalid'), results.length),
    refusalRate: rate(ended('refusal'), results.length),
    providerErrorRate: rate(ended('provider_error'), results.length),
    pairingHitRate: rate(answerable.filter((result) => result.hits > 0).length, answerable.length),
    honestyRate: rate(
      unanswerable.filter(
        (result) =>
          (result.outcome === 'answered' || result.outcome === 'text_only') &&
          result.recommended.length === 0,
      ).length,
      unanswerable.length,
    ),
    outsideCandidates: results.reduce(
      (sum, result) => sum + result.recommended.filter((sku) => sku === null).length,
      0,
    ),
    judgeScore:
      judged.length === 0
        ? null
        : judged.reduce((sum, verdict) => sum + verdict.score, 0) / judged.length,
    judgeRejections: judged.filter((verdict) => verdict.rejected).length,
  };
};
