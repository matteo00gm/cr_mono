import { SCHEMA_FAILURE_CEILING, type EvalSummary } from './metrics.js';

/** One provider's two runs, the unit of the bake-off table. */
export interface ProviderRuns {
  readonly provider: string;
  readonly runs: readonly [EvalSummary, EvalSummary];
}

/** The rates the table shows, in percentage points. */
const RATES = [
  ['Recall@8', 'recallAt8'],
  ['MRR', 'mrr'],
  ['Schema failures', 'schemaFailureRate'],
  ['Refusals', 'refusalRate'],
  ['Provider errors', 'providerErrorRate'],
  ['Pairing hits', 'pairingHitRate'],
  ['Honest "nothing"', 'honestyRate'],
] as const satisfies readonly (readonly [string, keyof EvalSummary])[];

const points = (value: number): string => (value * 100).toFixed(1);

/** The largest difference between the two runs, in percentage points, across every rate. */
export const runToRunSpread = ([first, second]: readonly [EvalSummary, EvalSummary]): number =>
  Math.max(...RATES.map(([, key]) => Math.abs(first[key] - second[key]) * 100));

const judge = (score: number | null): string => (score === null ? '—' : score.toFixed(2));

/**
 * The bake-off table (P1-46, for P1-47): a row per provider, each cell both runs.
 *
 * **The spread column exists to stop a false finding.** Two providers two
 * points apart, where either's own runs differ by three, are not two points
 * apart; they are indistinguishable, and the table says how far apart runs of
 * the same provider land so nobody has to remember to check.
 *
 * **The verdict is mechanical**: a schema-failure rate above the ceiling in
 * either run disqualifies, regardless of every other column.
 */
export const formatReport = (rows: readonly ProviderRuns[]): string => {
  const header = ['Provider', ...RATES.map(([label]) => label), 'Judge', 'Spread (pts)', 'Verdict'];

  const lines = rows.map(({ provider, runs }) => {
    const [first, second] = runs;
    const disqualified = runs.some((run) => run.schemaFailureRate > SCHEMA_FAILURE_CEILING);

    return [
      provider,
      ...RATES.map(([, key]) => `${points(first[key])} / ${points(second[key])}`),
      `${judge(first.judgeScore)} / ${judge(second.judgeScore)}`,
      runToRunSpread(runs).toFixed(1),
      disqualified
        ? `disqualified: schema failures above ${points(SCHEMA_FAILURE_CEILING)}%`
        : 'eligible',
    ];
  });

  return [header, header.map(() => '---'), ...lines]
    .map((cells) => `| ${cells.join(' | ')} |`)
    .join('\n');
};
