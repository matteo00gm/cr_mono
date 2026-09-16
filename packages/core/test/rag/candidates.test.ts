import { describe, expect, it } from 'vitest';

import {
  capCandidates,
  InvalidCandidateCapError,
  MAX_CANDIDATES,
} from '../../src/rag/candidates.js';

/**
 * The candidate cap (P2-22).
 *
 * Almost too small to test, except for the one thing that is easy to get wrong
 * and impossible to notice: the pre-cap count. After the slice, "we found forty
 * and kept eight" and "we found exactly eight" are the same eight rows, and
 * §2.4's panel is the feature that needs to tell them apart.
 */

const wines = (count: number): string[] =>
  Array.from({ length: count }, (_, at) => `wine-${String(at)}`);

describe('the cap', () => {
  it('is eight, which is what the prompt, the latency and the attack surface each allow', () => {
    expect(MAX_CANDIDATES).toBe(8);
  });

  it('takes no more than eight', () => {
    expect(capCandidates(wines(40)).candidates).toHaveLength(8);
  });

  it('takes the best eight, in the order fusion produced', () => {
    expect(capCandidates(wines(40)).candidates).toEqual([
      'wine-0',
      'wine-1',
      'wine-2',
      'wine-3',
      'wine-4',
      'wine-5',
      'wine-6',
      'wine-7',
    ]);
  });

  it('leaves a shorter list alone', () => {
    expect(capCandidates(wines(3)).candidates).toEqual(['wine-0', 'wine-1', 'wine-2']);
  });

  it('takes a sweep value in place of the default, which is why it is a parameter', () => {
    expect(capCandidates(wines(40), 3).candidates).toHaveLength(3);
  });

  it('accepts a cap of zero as a cap', () => {
    // A sweep asking "what does the model say with no candidates at all?" is a
    // real question, and `cap || MAX_CANDIDATES` is the version that refuses it.
    expect(capCandidates(wines(40), 0).candidates).toEqual([]);
  });

  it('refuses a negative cap rather than dropping the last candidate', () => {
    // `slice(0, -1)` is the silent failure: a sweep would run, report, and have
    // measured something other than what it asked for.
    expect(() => capCandidates(wines(40), -1)).toThrow(InvalidCandidateCapError);
  });

  it('refuses a fractional cap', () => {
    expect(() => capCandidates(wines(40), 2.5)).toThrow(InvalidCandidateCapError);
  });

  it('names the offending value, so a sweep says which cell broke', () => {
    expect(() => capCandidates(wines(40), -1)).toThrow(/-1/);
  });
});

describe('the count before the cut', () => {
  it('reports what survived filtering, not what was kept', () => {
    expect(capCandidates(wines(40)).consideredCount).toBe(40);
  });

  it('separates "matched but weakly" from "nothing matched", which is §2.4s whole job', () => {
    const weak = capCandidates(wines(40));
    const nothing = capCandidates(wines(0));

    expect(weak.consideredCount).toBeGreaterThan(0);
    expect(nothing.consideredCount).toBe(0);
    expect(nothing.candidates).toEqual([]);
  });

  it('equals the kept count when nothing was dropped, without being derived from it', () => {
    expect(capCandidates(wines(3)).consideredCount).toBe(3);
  });
});

describe('what it does not do', () => {
  it('does not re-rank', () => {
    expect(capCandidates(['c', 'a', 'b'], 3).candidates).toEqual(['c', 'a', 'b']);
  });

  it('leaves the input alone', () => {
    const input = wines(12);

    capCandidates(input);

    expect(input).toHaveLength(12);
  });

  it('passes each candidate through by reference, so nothing is re-derived', () => {
    const wine = { productId: 'p1' };

    expect(capCandidates([wine]).candidates[0]).toBe(wine);
  });
});
