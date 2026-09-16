import { RRF_K } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  constraintsIn,
  DEFAULT_THRESHOLDS,
  escalationsFor,
  tierFor,
  type EscalationSignals,
  type ProviderTiers,
} from '../../src/rag/escalation.js';
import type { LlmProvider } from '../../src/rag/llm-provider.js';

/**
 * When a question is worth a better model (P2-28).
 *
 * The cases that matter are the two edges. A trigger that never fires is a
 * cascade that does not exist and a bill that looks great; a trigger that
 * always fires is the expensive tier with extra steps, and nothing in the
 * response would tell you which you had.
 *
 * The third is the empty catalogue. Nothing was retrieved because there is
 * nothing to retrieve, and a better model cannot recommend a wine the seller
 * does not stock — so that must not look like weak retrieval.
 */

/** Identified only; nothing here asks either tier to answer anything. */
const provider = (id: string): LlmProvider => ({
  id,
  streamPairing: () => ({
    [Symbol.asyncIterator]: () => ({
      next: () => Promise.resolve({ done: true, value: undefined }),
    }),
  }),
});

const TIERS: ProviderTiers = { base: provider('cheap'), strong: provider('strong') };

/** A question and a ranking that trigger nothing, so each case can turn one thing on. */
const CALM: EscalationSignals = {
  topScore: 1,
  query: 'un rosso',
  schemaFailed: false,
};

describe('nothing to escalate', () => {
  it('stays on the cheap tier when every signal is fine', () => {
    expect(escalationsFor(CALM)).toEqual([]);
    expect(tierFor(TIERS, escalationsFor(CALM)).id).toBe('cheap');
  });

  it('does not escalate a ranking exactly at the floor', () => {
    // `1 / (k + 1)` is what a wine scores when one branch ranks it first. That
    // is a first choice, so it is not weak — the threshold is strictly below.
    expect(escalationsFor({ ...CALM, topScore: DEFAULT_THRESHOLDS.minTopScore })).toEqual([]);
  });

  it('does not escalate an empty catalogue', () => {
    /*
     * There was nothing to retrieve. A better model cannot recommend a wine
     * the seller does not stock, so escalating spends more to produce the same
     * "I have nothing for that" — and §2.4's panel is what that seller needs
     * instead.
     */
    expect(escalationsFor({ ...CALM, topScore: undefined })).toEqual([]);
    expect(tierFor(TIERS, escalationsFor({ ...CALM, topScore: undefined })).id).toBe('cheap');
  });

  it('does not escalate a question at the constraint limit', () => {
    const query = 'un rosso piemontese, secco';

    expect(constraintsIn(query)).toBe(DEFAULT_THRESHOLDS.maxConstraints);
    expect(escalationsFor({ ...CALM, query })).toEqual([]);
  });
});

describe('each trigger, on its own', () => {
  it('escalates when nothing retrieved was any branch first choice', () => {
    const reasons = escalationsFor({ ...CALM, topScore: DEFAULT_THRESHOLDS.minTopScore / 2 });

    expect(reasons).toEqual(['weak_retrieval']);
    expect(tierFor(TIERS, reasons).id).toBe('strong');
  });

  it('escalates when the cheap tier could not produce the schema', () => {
    const reasons = escalationsFor({ ...CALM, schemaFailed: true });

    expect(reasons).toEqual(['schema_invalid']);
    expect(tierFor(TIERS, reasons).id).toBe('strong');
  });

  it('escalates a question longer than the threshold', () => {
    const reasons = escalationsFor({
      ...CALM,
      query: 'a'.repeat(DEFAULT_THRESHOLDS.maxQueryCharacters + 1),
    });

    expect(reasons).toEqual(['complex_query']);
  });

  it('escalates a question asking for more things than the threshold', () => {
    const query = 'un rosso piemontese sotto i 20 euro, non troppo tannico, per brasato';

    expect(constraintsIn(query)).toBeGreaterThan(DEFAULT_THRESHOLDS.maxConstraints);
    expect(escalationsFor({ ...CALM, query })).toEqual(['complex_query']);
  });
});

describe('the metric behind the decision', () => {
  it('records every reason, not the first one it found', () => {
    /*
     * One escalation happens either way — the provider is swapped once. But a
     * metric carrying only the first reason would attribute a climbing rate to
     * whichever check is written above the others, which is the one number this
     * row exists to make trustworthy.
     */
    const reasons = escalationsFor({
      topScore: 0,
      query: 'un rosso piemontese sotto i 20 euro, non troppo tannico, per brasato',
      schemaFailed: true,
    });

    expect(reasons).toEqual(['weak_retrieval', 'schema_invalid', 'complex_query']);
  });

  it('escalates exactly once however many reasons fired', () => {
    const reasons = escalationsFor({ topScore: 0, query: 'a, b, c, d', schemaFailed: true });

    expect(reasons.length).toBeGreaterThan(1);
    expect(tierFor(TIERS, reasons)).toBe(TIERS.strong);
  });
});

describe('the thresholds', () => {
  it('takes the caller values, which is what lets P1-46 sweep them', () => {
    const generous = { minTopScore: 0, maxQueryCharacters: 10_000, maxConstraints: 100 };

    expect(
      escalationsFor(
        { topScore: 0.000_01, query: 'a, b, c, d, e, f', schemaFailed: false },
        generous,
      ),
    ).toEqual([]);
  });

  it('derives the retrieval floor from the fusion constant rather than picking a number', () => {
    /*
     * Read off `RRF_K`, not restated. A wine one branch ranks first and the
     * other misses scores exactly `1 / (k + 1)`, so the floor means "no wine
     * was any branch's first choice" — and it keeps meaning that if P1-46's
     * sweep moves `k`. A literal here would go on meaning 1/61.
     */
    expect(DEFAULT_THRESHOLDS.minTopScore).toBe(1 / (RRF_K + 1));
  });
});

describe('counting what a question asks for', () => {
  it('counts the question itself', () => {
    expect(constraintsIn('un rosso')).toBe(1);
  });

  it('counts each marker it finds', () => {
    expect(constraintsIn('un rosso e un bianco')).toBe(2);
    expect(constraintsIn('un rosso, secco, sotto i 20 euro')).toBe(4);
  });

  it('reads a question whatever case it was typed in', () => {
    expect(constraintsIn('Un rosso SENZA solfiti')).toBe(2);
  });

  it('does not count a marker inside a word', () => {
    // ` e ` with its spaces, never `e`: "bene" and "vendemmia" are not two
    // constraints, and a substring match without the spaces says they are.
    expect(constraintsIn('bene vendemmia')).toBe(1);
  });

  it('counts a marker the question opens with', () => {
    /*
     * The padding earns its keep here. A visitor typing "senza solfiti" has
     * stated a constraint, and a marker written ` senza ` cannot match at the
     * start of a string that is not padded — so the question would be counted
     * as asking for nothing in particular.
     */
    expect(constraintsIn('senza solfiti')).toBe(2);
    expect(constraintsIn('non troppo tannico')).toBe(2);
  });
});
