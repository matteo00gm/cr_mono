import { PRUNE_BATCH, pruneClosedWindows, pruneLapsedRevocations } from '@catalogorosso/db';

/**
 * The sweep (P2-14).
 *
 * Two tables grow on every request and shrink only here: `token_revocations`,
 * whose rows stop meaning anything once their token can no longer be presented,
 * and `rate_limit_buckets`, whose rows stop meaning anything once their window
 * closes. A sweep that silently stops leaves both growing until the limiter is
 * slower than what it protects, which is why a run reports what it deleted as a
 * metric and a day without a deleted row alarms.
 */

/** How many batches one run deletes from each table before it leaves the rest for the next. */
export const MAX_SWEEP_PASSES = 50;

/** CloudWatch reads this out of the run's own log line (Embedded Metric Format). */
export const SWEEP_METRIC_NAMESPACE = 'Catalogorosso/Sweep';
export const SWEEP_DELETED_METRIC = 'DeletedRows';

/** Deletes up to `limit` rows and says how many went. */
export type Prune = (limit: number) => Promise<number>;

/** The statements a run drains, named so a test can see they are the real ones. */
export const SWEPT_TABLES: { readonly revocations: Prune; readonly buckets: Prune } = {
  revocations: pruneLapsedRevocations,
  buckets: pruneClosedWindows,
};

export interface TableSweep {
  readonly deleted: number;
  readonly passes: number;
  /** False when the run stopped at the pass cap with rows still to delete. */
  readonly drained: boolean;
}

export interface SweepResult {
  readonly revocations: TableSweep;
  readonly buckets: TableSweep;
}

export interface DrainOptions {
  readonly limit?: number | undefined;
  readonly maxPasses?: number | undefined;
}

/**
 * Deletes batch after batch until one comes back short.
 *
 * A short batch saw the end of what there is to delete, so another would be a
 * round trip to learn nothing is left. Capped, because this runs against a
 * wall clock: what the cap leaves behind is the next run's first batch.
 */
export const drain = async (
  prune: Prune,
  { limit = PRUNE_BATCH, maxPasses = MAX_SWEEP_PASSES }: DrainOptions = {},
): Promise<TableSweep> => {
  let deleted = 0;

  for (let pass = 1; pass <= maxPasses; pass += 1) {
    const batch = await prune(limit);
    deleted += batch;

    if (batch < limit) return { deleted, passes: pass, drained: true };
  }

  return { deleted, passes: maxPasses, drained: false };
};

/** One table failed; the other was still swept, and the run still fails so the error is seen. */
export class SweepFailedError extends Error {
  constructor(cause: unknown) {
    super('The sweep failed on at least one table; the other was still swept (P2-14).', {
      cause,
    });
    this.name = 'SweepFailedError';
  }
}

export interface SweepOptions extends DrainOptions {
  readonly pruneRevocations?: Prune | undefined;
  readonly pruneBuckets?: Prune | undefined;
}

/**
 * Both tables, one after the other.
 *
 * In turn rather than together, so a run holds one connection. A failure in
 * one does not starve the other: a revocation table the sweep cannot reach is
 * no reason to let the bucket table grow as well.
 */
export const sweep = async ({
  pruneRevocations = (limit) => SWEPT_TABLES.revocations(limit),
  pruneBuckets = (limit) => SWEPT_TABLES.buckets(limit),
  ...options
}: SweepOptions = {}): Promise<SweepResult> => {
  let failure: unknown;

  const attempt = async (prune: Prune): Promise<TableSweep | undefined> => {
    try {
      return await drain(prune, options);
    } catch (error) {
      failure ??= error;
      return undefined;
    }
  };

  const revocations = await attempt(pruneRevocations);
  const buckets = await attempt(pruneBuckets);

  if (revocations === undefined || buckets === undefined) throw new SweepFailedError(failure);

  return { revocations, buckets };
};

/**
 * The run's one log line, which is also its metric.
 *
 * **Embedded Metric Format**, so CloudWatch extracts `DeletedRows` from the log
 * with no metric filter to wire and forget. A run that never logs is a run that
 * never reported, which is what the alarm is for.
 */
export const metricLine = (result: SweepResult, stage: string, now: number = Date.now()): string =>
  JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: SWEEP_METRIC_NAMESPACE,
          Dimensions: [['Stage']],
          Metrics: [{ Name: SWEEP_DELETED_METRIC, Unit: 'Count' }],
        },
      ],
    },
    Stage: stage,
    [SWEEP_DELETED_METRIC]: result.revocations.deleted + result.buckets.deleted,
    event: 'sweep.completed',
    revocations: result.revocations,
    buckets: result.buckets,
  });

export interface HandlerOptions extends SweepOptions {
  /** Where the metric line is written. Standard output in Lambda, which is what EMF reads. */
  readonly log?: ((line: string) => void) | undefined;
}

/** The Lambda entry point, on a fifteen-minute schedule (`infra/schedules.ts`). */
export const handler = async (
  _event?: unknown,
  _context?: unknown,
  { log = (line) => process.stdout.write(`${line}\n`), ...options }: HandlerOptions = {},
): Promise<SweepResult> => {
  const result = await sweep(options);

  log(metricLine(result, process.env.SST_STAGE ?? 'unknown'));

  return result;
};
