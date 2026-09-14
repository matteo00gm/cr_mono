import { describe, expect, it } from 'vitest';

import { firstHitRank, summarise, type QueryResult } from '../src/metrics.js';

/** The scores a run is judged by (P1-46): recall@8, MRR, the schema-failure rate, and honesty. */

const result = (over: Partial<QueryResult> = {}): QueryResult => ({
  queryId: 'q01',
  kind: 'dish',
  retrieved: [],
  firstHitRank: null,
  outcome: 'answered',
  reply: '',
  recommended: [],
  hits: 0,
  judge: null,
  ...over,
});

describe('firstHitRank', () => {
  it('is the 1-based rank of the first acceptable SKU', () => {
    expect(firstHitRank(['A', 'B', 'C'], ['C', 'B'])).toBe(2);
  });

  it('is null when nothing retrieved is acceptable, or the first sits past the limit', () => {
    expect(firstHitRank(['A', 'B'], ['Z'])).toBeNull();
    expect(firstHitRank(['A', 'B', 'C'], ['C'], 2)).toBeNull();
  });
});

describe('summarise', () => {
  it('scores retrieval and pairing over answerable queries, and honesty over the rest', () => {
    const summary = summarise('fake', [
      result({ firstHitRank: 1, hits: 1, recommended: ['A'] }),
      result({ firstHitRank: 4, recommended: ['B'] }),
      result({ outcome: 'schema_invalid' }),
      result({ kind: 'unanswerable', outcome: 'text_only' }),
      result({ kind: 'unanswerable', outcome: 'answered', recommended: [null] }),
      result({ kind: 'unanswerable', outcome: 'refusal' }),
    ]);

    expect(summary).toEqual({
      provider: 'fake',
      queries: 6,
      recallAt8: 2 / 3,
      mrr: (1 + 1 / 4) / 3,
      schemaFailureRate: 1 / 6,
      refusalRate: 1 / 6,
      providerErrorRate: 0,
      pairingHitRate: 1 / 3,
      honestyRate: 1 / 3,
      outsideCandidates: 1,
      judgeScore: null,
      judgeRejections: 0,
    });
  });

  it('counts an empty set of recommendations as an honest answer', () => {
    expect(
      summarise('fake', [result({ kind: 'unanswerable', outcome: 'answered' })]).honestyRate,
    ).toBe(1);
  });

  it('reports provider errors, the mean judge score and the rejections', () => {
    const summary = summarise('fake', [
      result({ outcome: 'provider_error' }),
      result({ judge: { score: 0.5, rejected: true } }),
      result({ judge: { score: 1, rejected: false } }),
    ]);

    expect([summary.providerErrorRate, summary.judgeScore, summary.judgeRejections]).toEqual([
      1 / 3,
      0.75,
      1,
    ]);
  });

  it('scores zero rather than NaN when there is nothing to score', () => {
    const summary = summarise('fake', []);

    expect([
      summary.recallAt8,
      summary.mrr,
      summary.schemaFailureRate,
      summary.honestyRate,
    ]).toEqual([0, 0, 0, 0]);
  });
});
