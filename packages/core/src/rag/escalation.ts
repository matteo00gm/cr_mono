import type { LlmProvider } from './llm-provider.js';

/**
 * When a question is worth a better model (P2-28, §4.5).
 *
 * **A provider swap, not a second code path.** Escalation picks a different
 * `LlmProvider` and changes nothing else — same prompt, same schema, same
 * allowlist, same repair. A cascade written as a branch would be a second
 * pipeline whose differences from the first are discovered in production.
 *
 * **The rate matters more than any single escalation.** A few percent is the
 * cheap tier doing its job; a climbing rate is the cheap tier failing, and it
 * is the signal to revisit §Open Decision 1 rather than to raise a threshold
 * until the number looks better. That is why every escalation reports *why*.
 */

/** Why a question was sent to the stronger tier. */
export type EscalationReason =
  /** Nothing retrieved was any branch's first choice, so the model has little to work with. */
  | 'weak_retrieval'
  /** The cheap tier could not produce the schema (P2-27's first attempt). */
  | 'schema_invalid'
  /** The question carries more, or asks more, than the cheap tier handles well. */
  | 'complex_query';

export interface EscalationThresholds {
  /**
   * The fused score below which retrieval counts as weak.
   *
   * **Derived rather than picked**: `1 / (k + 1)` is exactly what a wine scores
   * when one branch ranks it first and the other never finds it, so a top score
   * below it means *no wine was any branch's first choice*. That is a statement
   * about the ranking rather than a number somebody liked, and it moves
   * correctly if `k` ever does.
   */
  readonly minTopScore: number;
  /**
   * How long a question may be before it counts as complex.
   *
   * A starting point, not a finding — which is the whole reason it is a
   * parameter. P1-46's eval sweeps it against the golden set; until then it is
   * a guess that is easy to correct and impossible to hide.
   */
  readonly maxQueryCharacters: number;
  /** How many constraints a question may carry before it counts as complex. Also a starting point. */
  readonly maxConstraints: number;
}

/**
 * What a constraint looks like in a visitor's question.
 *
 * **A proxy, and named as one.** Counting constraints properly means parsing
 * Italian, which is the job of the model this is deciding whether to call. What
 * these markers measure is how much the question is *asking for at once* — "un
 * rosso piemontese sotto i 20 euro, non troppo tannico, per brasato" trips four
 * of them — and that correlates with the failures §4.5 wants escalated.
 *
 * Written out rather than inferred, so a change to it is a change somebody made.
 */
const CONSTRAINT_MARKERS = [
  ',',
  ' e ',
  ' ma ',
  ' con ',
  ' senza ',
  ' sotto ',
  ' sopra ',
  ' oltre ',
  ' meno di ',
  ' più di ',
  ' non ',
  ' and ',
  ' but ',
  ' with ',
  ' without ',
  ' under ',
  ' over ',
] as const;

export const DEFAULT_THRESHOLDS: EscalationThresholds = {
  /**
   * `1 / (RRF_K + 1)`, written out rather than imported.
   *
   * **Not the duplication P0-42 forbids, and the reason is measurable.** This
   * module is a pure decision and `RRF_K` lives in `packages/db`, so importing
   * it would put the driver barrel in the module graph of everything that
   * reaches escalation — the first attempt broke nine unrelated suites that
   * mock `@catalogorosso/db`, none of which has any business knowing retrieval
   * exists. The agreement is kept by a test that imports both and fails if they
   * drift, which is a guard that can fail rather than an import that cannot.
   */
  minTopScore: 1 / 61,
  maxQueryCharacters: 200,
  maxConstraints: 2,
};

/** How many things a question is asking for at once. Always at least one: the question itself. */
export const constraintsIn = (query: string): number => {
  const text = ` ${query.toLowerCase()} `;

  return CONSTRAINT_MARKERS.reduce((count, marker) => count + text.split(marker).length - 1, 1);
};

export interface EscalationSignals {
  /** The best fused score retrieval produced, or `undefined` when it produced nothing. */
  readonly topScore: number | undefined;
  /** The visitor's question, as they wrote it. */
  readonly query: string;
  /** Whether the cheap tier's first attempt missed the schema (P2-27). */
  readonly schemaFailed: boolean;
}

/**
 * Every reason this question should go to the stronger tier.
 *
 * **All of them, not the first.** One escalation happens either way — the
 * caller swaps the provider once — but a metric that recorded only the first
 * reason would attribute a climbing rate to whichever check happens to be
 * written above the others.
 *
 * **An empty catalogue is not weak retrieval.** Nothing was retrieved because
 * there is nothing to retrieve, and a better model cannot recommend a wine the
 * seller does not stock. Escalating there spends more money to produce the same
 * "I have nothing for that" (§2.4's `ZERO_RESULTS` is what that seller needs).
 */
export const escalationsFor = (
  { topScore, query, schemaFailed }: EscalationSignals,
  thresholds: EscalationThresholds = DEFAULT_THRESHOLDS,
): readonly EscalationReason[] => {
  const reasons: EscalationReason[] = [];

  if (topScore !== undefined && topScore < thresholds.minTopScore) reasons.push('weak_retrieval');
  if (schemaFailed) reasons.push('schema_invalid');

  if (
    query.length > thresholds.maxQueryCharacters ||
    constraintsIn(query) > thresholds.maxConstraints
  ) {
    reasons.push('complex_query');
  }

  return reasons;
};

/** The two models a request can be answered by. Both implement the same port (P1-41). */
export interface ProviderTiers {
  readonly base: LlmProvider;
  readonly strong: LlmProvider;
}

/**
 * Which model answers, given the reasons.
 *
 * One line, and it is the whole of what escalation *does* — which is the point
 * the row makes by insisting escalation reuse the interface. Everything else in
 * this file decides; nothing else branches.
 */
export const tierFor = (tiers: ProviderTiers, reasons: readonly EscalationReason[]): LlmProvider =>
  reasons.length > 0 ? tiers.strong : tiers.base;
