import { describe, expect, it, vi } from 'vitest';

import {
  daysToRollUp,
  handler,
  MAX_ROLLUP_DAYS,
  metricLine,
  ROLLUP_TENANT_COST_METRIC,
  rollup,
  ROLLUP_METRIC_NAMESPACE,
  ROLLUP_RUNS_METRIC,
  RollupFailedError,
} from '../src/rollup.js';

/**
 * The nightly rollup (P5-13): which days, which tenants, what is logged, and
 * that one failure neither stops the rest nor goes unseen.
 */

const NOW = new Date('2026-10-15T01:30:00Z');

const tenant = (id: string, createdAt = '2026-01-01T00:00:00Z') => ({
  id,
  createdAt: new Date(createdAt),
});

describe('the window', () => {
  it('is the last whole UTC days, oldest first, never today', () => {
    expect(daysToRollUp(NOW)).toEqual(['2026-10-13', '2026-10-14']);
    expect(daysToRollUp(new Date('2026-10-15T23:59:59Z'), 1)).toEqual(['2026-10-14']);
  });

  it('crosses a month and a year', () => {
    expect(daysToRollUp(new Date('2027-01-01T01:30:00Z'), 2)).toEqual(['2026-12-30', '2026-12-31']);
  });

  it.each([0, -1, 1.5, MAX_ROLLUP_DAYS + 1])('is bounded: %s days is refused', (days) => {
    expect(() => daysToRollUp(NOW, days)).toThrow(RangeError);
  });

  it('allows a month of backfill', () => {
    expect(daysToRollUp(NOW, MAX_ROLLUP_DAYS)).toHaveLength(MAX_ROLLUP_DAYS);
  });
});

describe('a run', () => {
  it('rolls up every tenant’s every day, through the scope it is handed', async () => {
    const asked: string[] = [];

    const result = await rollup({
      now: () => NOW,
      listTenants: () => Promise.resolve([tenant('a'), tenant('b')]),
      rollupDay: (tenantId, day) => {
        asked.push(`${tenantId}:${day}`);
        return Promise.resolve();
      },
    });

    expect(asked).toEqual(['a:2026-10-13', 'a:2026-10-14', 'b:2026-10-13', 'b:2026-10-14']);
    expect(result).toMatchObject({ tenants: 2, rows: 4, failed: 0 });
  });

  it('skips the days before a winery existed, and keeps the day it was made', async () => {
    const asked: string[] = [];

    await rollup({
      now: () => NOW,
      listTenants: () => Promise.resolve([tenant('new', '2026-10-14T18:00:00Z')]),
      rollupDay: (tenantId, day) => {
        asked.push(`${tenantId}:${day}`);
        return Promise.resolve();
      },
    });

    expect(asked).toEqual(['new:2026-10-14']);
  });

  it('carries on past a failing tenant, and counts it', async () => {
    const asked: string[] = [];
    const boom = new Error('db down');

    const result = await rollup({
      now: () => NOW,
      days: 1,
      listTenants: () => Promise.resolve([tenant('a'), tenant('b')]),
      rollupDay: (tenantId) => {
        asked.push(tenantId);
        return tenantId === 'a' ? Promise.reject(boom) : Promise.resolve();
      },
    });

    expect(asked).toEqual(['a', 'b']);
    expect(result).toMatchObject({ rows: 1, failed: 1, firstFailure: boom });
  });

  it('reports the dearest day any one winery had, and not whose it was (P7-02)', async () => {
    const costs: Record<string, number> = {
      'a:2026-10-13': 40_000,
      'a:2026-10-14': 2_500_000,
      'b:2026-10-13': 900_000,
      'b:2026-10-14': 0,
    };

    const result = await rollup({
      now: () => NOW,
      listTenants: () => Promise.resolve([tenant('a'), tenant('b')]),
      rollupDay: (tenantId, day) =>
        Promise.resolve({ costMicros: costs[`${tenantId}:${day}`], messages: 1 }),
    });

    /* The maximum, not the sum: three wineries at a euro are not one winery at three. */
    expect(result.maxTenantCostMicros).toBe(2_500_000);

    const line = JSON.parse(metricLine(result, 'dev', 1)) as Record<string, unknown>;

    expect(line.MaxTenantCostMicros).toBe(2_500_000);
    expect(JSON.stringify(line)).not.toMatch(/"a"|"b"/u);
  });

  it.each([
    ['said nothing', undefined],
    ['said something that is not a number', { costMicros: 'a lot' }],
    ['said not-a-number', { costMicros: Number.NaN }],
  ])('counts a day whose rollup %s as nought, and still as a row', async (_what, answer) => {
    const result = await rollup({
      now: () => NOW,
      days: 1,
      listTenants: () => Promise.resolve([tenant('a')]),
      rollupDay: () => Promise.resolve(answer),
    });

    expect(result).toMatchObject({ rows: 1, maxTenantCostMicros: 0 });
  });

  it('leaves a failed day out of the maximum', async () => {
    const result = await rollup({
      now: () => NOW,
      days: 1,
      listTenants: () => Promise.resolve([tenant('a'), tenant('b')]),
      rollupDay: (tenantId) =>
        tenantId === 'a'
          ? Promise.reject(new Error('db down'))
          : Promise.resolve({ costMicros: 7 }),
    });

    expect(result).toMatchObject({ failed: 1, maxTenantCostMicros: 7 });
  });
});

describe('the handler', () => {
  const options = (fail: boolean) => ({
    now: () => NOW,
    days: 1,
    listTenants: () => Promise.resolve([tenant('a')]),
    rollupDay: () => (fail ? Promise.reject(new Error('db down')) : Promise.resolve()),
  });

  it('logs one line that is also its metrics', async () => {
    const lines: string[] = [];

    await handler(undefined, undefined, { ...options(false), log: (line) => lines.push(line) });

    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'rollup.completed',
      Runs: 1,
      RolledUpRows: 1,
      days: ['2026-10-14'],
      failed: 0,
    });
  });

  it('logs before it fails, so a failing night still reports that it ran', async () => {
    const log = vi.fn();

    await expect(handler(undefined, undefined, { ...options(true), log })).rejects.toThrow(
      RollupFailedError,
    );
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('writes the metric the alarm watches', () => {
    // infra/test/rollup-config.test.ts pins the same two strings from its side.
    expect([ROLLUP_METRIC_NAMESPACE, ROLLUP_RUNS_METRIC]).toEqual(['Catalogorosso/Rollup', 'Runs']);
    const line = JSON.parse(
      metricLine({ days: [], tenants: 0, rows: 0, failed: 0, maxTenantCostMicros: 0 }, 'dev', 1),
    ) as {
      _aws: { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] };
    };

    expect(line._aws.CloudWatchMetrics[0]?.Namespace).toBe('Catalogorosso/Rollup');
    /* Declared in the envelope, or CloudWatch reads the number as a field and publishes nothing. */
    expect(line._aws.CloudWatchMetrics[0]?.Metrics.map((metric) => metric.Name)).toEqual([
      'Runs',
      'RolledUpRows',
      'MaxTenantCostMicros',
    ]);
    expect(ROLLUP_TENANT_COST_METRIC).toBe('MaxTenantCostMicros');
  });
});
