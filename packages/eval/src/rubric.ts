import { createHash } from 'node:crypto';

import type { CandidateProduct, Recommendation } from '@catalogorosso/core';

import type { EvalQuery } from './dataset.js';

/**
 * How a pairing is judged (P1-46).
 *
 * **Sommelier logic, not fluency.** A small model writes confident, well-formed
 * Italian that is oenological nonsense — a sweet Moscato "beautifully"
 * accompanying a steak reads fine and is wrong — and a judge asked whether an
 * answer sounds good passes exactly the model the bake-off must reject. So the
 * rubric scores the reason against the mechanics of pairing, and rejects a
 * defensible wine given for a wrong reason, because the reason is what the
 * visitor reads.
 *
 * The judge itself is a port: the rubric and the scoring are fixed here, and
 * which stronger model applies them is part of P1-47's run.
 */
export const PAIRING_RUBRIC = [
  'Score one wine recommendation for a visitor to an Italian wine shop, from 0 to 1.',
  '',
  "Score the sommelier's reasoning, not the prose. Fluent, confident Italian that is wrong about wine scores low.",
  '',
  'Judge each stated reason against how pairing works:',
  '1. Fat and protein want tannin or acidity: grilled pork, braised beef.',
  '2. Acidity in the dish needs matching acidity in the wine, or the wine tastes flat.',
  '3. The wine must be at least as sweet as the dish; this is where dessert pairings usually fail.',
  '4. Intensity must match: a delicate wine is erased by a robust dish.',
  "5. A reason may cite only attributes the wine's record carries. An invented attribute is a hallucination.",
  '',
  'Set rejected to true when a wine is defensible but its stated reason is wrong: a confidently wrong explanation is worse than a terse one.',
  '',
  'When the shop has nothing suitable, an honest answer that recommends nothing is correct and scores 1.',
].join('\n');

export interface JudgeInput {
  readonly query: EvalQuery;
  /** Exactly what the model was given, so attribute grounding is checked against it. */
  readonly candidates: readonly CandidateProduct[];
  readonly reply: string;
  readonly recommendations: readonly Recommendation[];
}

export interface JudgeVerdict {
  /** From 0 to 1, against the rubric. */
  readonly score: number;
  /** A defensible wine given for a wrong reason: the rubric's hard rule. */
  readonly rejected: boolean;
}

export type Judge = (input: JudgeInput, signal: AbortSignal) => Promise<JudgeVerdict>;

/**
 * The queries reserved for human rating (P1-46).
 *
 * Chosen by a hash of the query id rather than at random, so the sample does not
 * move between runs or between the people rating it, and a judge can be checked
 * against the same answers' questions every time. Returned in id order.
 */
export const humanSample = (queries: readonly EvalQuery[], size: number): readonly EvalQuery[] =>
  queries
    .map((query) => ({ query, key: createHash('sha256').update(query.id).digest('hex') }))
    .sort((a, b) => (a.key < b.key ? -1 : 1))
    .slice(0, size)
    .map(({ query }) => query)
    .sort((a, b) => (a.id < b.id ? -1 : 1));
