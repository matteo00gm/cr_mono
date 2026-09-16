import { PRUNE_BATCH, pruneClosedWindows, pruneLapsedRevocations } from '@catalogorosso/db';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  drain,
  handler,
  MAX_SWEEP_PASSES,
  metricLine,
  sweep,
  SWEEP_DELETED_METRIC,
  SWEEP_METRIC_NAMESPACE,
  SweepFailedError,
  SWEPT_TABLES,
  type Prune,
} from '../src/sweep.js';

/**
 * The sweep's loop, its failure handling and what it reports (P2-14).
 *
 * The statements themselves — which rows each may delete — are asserted against
 * Postgres in `packages/db` and `packages/testing`. What is here is the part most
 * likely to be wrong without a database: when a run stops, and whether it tells
 * anyone what it did.
 */

afterEach(() => {
  vi.unstubAllEnvs();
});

/** A table holding `rows` deletable rows, recording every batch it was asked for. */
const tableOf = (rows: number) => {
  let left = rows;
  const asked: number[] = [];
  const prune: Prune = (limit) => {
    asked.push(limit);
    const batch = Math.min(left, limit);
    left -= batch;
    return Promise.resolve(batch);
  };
  return { prune, asked };
};

describe('drain', () => {
  it('deletes batch after batch, and stops on the first short one', async () => {
    const { prune, asked } = tableOf(25);

    expect(await drain(prune, { limit: 10 })).toEqual({ deleted: 25, passes: 3, drained: true });
    expect(asked).toEqual([10, 10, 10]);
  });

  it('asks once, and stops, when there is nothing to delete', async () => {
    const { prune, asked } = tableOf(0);

    expect(await drain(prune)).toEqual({ deleted: 0, passes: 1, drained: true });
    expect(asked).toEqual([PRUNE_BATCH]);
  });

  it('asks again after a batch that came back exactly full', async () => {
    // A full batch may have been the last one, and only the next can say.
    const { prune } = tableOf(20);

    expect(await drain(prune, { limit: 10 })).toEqual({ deleted: 20, passes: 3, drained: true });
  });

  it('stops at its pass cap and says the table was not drained', async () => {
    const { prune } = tableOf(1_000_000);

    expect(await drain(prune, { limit: 10 })).toEqual({
      deleted: 10 * MAX_SWEEP_PASSES,
      passes: MAX_SWEEP_PASSES,
      drained: false,
    });
  });
});

describe('sweep', () => {
  it('drains both tables with the same batch', async () => {
    const revocations = tableOf(5);
    const buckets = tableOf(12);

    const result = await sweep({
      pruneRevocations: revocations.prune,
      pruneBuckets: buckets.prune,
      limit: 10,
    });

    expect(result).toEqual({
      revocations: { deleted: 5, passes: 1, drained: true },
      buckets: { deleted: 12, passes: 2, drained: true },
    });
  });

  it('still sweeps the other table when one fails, and then fails the run', async () => {
    const broken = new Error('permission denied for table token_revocations');
    const buckets = tableOf(3);

    const failure = await sweep({
      pruneRevocations: () => Promise.reject(broken),
      pruneBuckets: buckets.prune,
    }).catch((error: unknown) => error);

    expect(buckets.asked).toHaveLength(1);
    expect(failure).toBeInstanceOf(SweepFailedError);
    expect((failure as SweepFailedError).cause).toBe(broken);
  });

  it('runs the real statements when none are injected', () => {
    // Identity, not shape: a wrapper with the right signature would pass a shape check.
    expect(SWEPT_TABLES.revocations).toBe(pruneLapsedRevocations);
    expect(SWEPT_TABLES.buckets).toBe(pruneClosedWindows);
  });
});

describe('what a run reports', () => {
  const result = {
    revocations: { deleted: 4, passes: 1, drained: true },
    buckets: { deleted: 1_200, passes: 2, drained: true },
  };

  it('is one Embedded Metric Format line carrying the rows deleted, by stage', () => {
    const line = JSON.parse(metricLine(result, 'production', 1_789_466_400_000)) as Record<
      string,
      unknown
    >;

    expect(line).toMatchObject({
      _aws: {
        Timestamp: 1_789_466_400_000,
        CloudWatchMetrics: [
          {
            Namespace: 'Catalogorosso/Sweep',
            Dimensions: [['Stage']],
            Metrics: [{ Name: 'DeletedRows', Unit: 'Count' }],
          },
        ],
      },
      Stage: 'production',
      DeletedRows: 1_204,
      revocations: result.revocations,
      buckets: result.buckets,
    });
    // The alarm in `infra/schedules.ts` names these two strings; they are a contract.
    expect([SWEEP_METRIC_NAMESPACE, SWEEP_DELETED_METRIC]).toEqual([
      'Catalogorosso/Sweep',
      'DeletedRows',
    ]);
  });

  it('is written once per run, under the stage the function runs in', async () => {
    vi.stubEnv('SST_STAGE', 'review');
    const lines: string[] = [];

    await handler(undefined, undefined, {
      log: (line) => lines.push(line),
      pruneRevocations: tableOf(2).prune,
      pruneBuckets: tableOf(0).prune,
    });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({ Stage: 'review', DeletedRows: 2 });
  });

  it('is not written for a run that failed, which the function error reports instead', async () => {
    const lines: string[] = [];

    await expect(
      handler(undefined, undefined, {
        log: (line) => lines.push(line),
        pruneRevocations: () => Promise.reject(new Error('down')),
        pruneBuckets: tableOf(0).prune,
      }),
    ).rejects.toThrow(SweepFailedError);
    expect(lines).toEqual([]);
  });
});
