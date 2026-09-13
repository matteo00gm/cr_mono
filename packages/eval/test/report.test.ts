import { describe, expect, it } from 'vitest';

import { summarise, type EvalSummary } from '../src/metrics.js';
import { formatReport, runToRunSpread } from '../src/report.js';

/** The bake-off table (P1-46): both runs in every cell, the spread, and a mechanical verdict. */

const summary = (over: Partial<EvalSummary> = {}): EvalSummary => ({
  ...summarise('nova-lite', []),
  ...over,
});

describe('formatReport', () => {
  it('writes a markdown row per provider, with both runs in every cell', () => {
    const [header, rule, row] = formatReport([
      {
        provider: 'nova-lite',
        runs: [summary({ recallAt8: 0.75, judgeScore: 0.8 }), summary({ recallAt8: 0.7 })],
      },
    ]).split('\n');

    expect(header).toBe(
      '| Provider | Recall@8 | MRR | Schema failures | Refusals | Provider errors | Pairing hits | Honest "nothing" | Judge | Spread (pts) | Verdict |',
    );
    expect(rule).toBe(`|${' --- |'.repeat(11)}`);
    expect(row).toBe(
      '| nova-lite | 75.0 / 70.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.0 / 0.0 | 0.80 / — | 5.0 | eligible |',
    );
  });

  it('disqualifies a provider whose schema failures pass the ceiling in either run, and only then', () => {
    const [, , over, at] = formatReport([
      {
        provider: 'a',
        runs: [summary({ schemaFailureRate: 0.02 }), summary({ schemaFailureRate: 0.021 })],
      },
      {
        provider: 'b',
        runs: [summary({ schemaFailureRate: 0.02 }), summary({ schemaFailureRate: 0.02 })],
      },
    ]).split('\n');

    expect(over).toMatch(/\| disqualified: schema failures above 2\.0% \|$/);
    expect(at).toMatch(/\| eligible \|$/);
  });
});

describe('runToRunSpread', () => {
  it('is the widest difference between the runs across every rate, in points', () => {
    expect(
      runToRunSpread([
        summary({ mrr: 0.5, honestyRate: 0.5 }),
        summary({ mrr: 0.52, honestyRate: 0.4 }),
      ]),
    ).toBeCloseTo(10);
  });
});
