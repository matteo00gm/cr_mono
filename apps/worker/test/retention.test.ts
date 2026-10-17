import { describe, expect, it, vi } from 'vitest';

import {
  DEFAULT_TRANSCRIPT_RETENTION_DAYS,
  eventCutoff,
  handler,
  metricLine,
  PurgeFailedError,
  purgeRetained,
  RETENTION_METRIC_NAMESPACE,
  RETENTION_PURGED_METRIC,
  RETENTION_RUNS_METRIC,
  transcriptCutoff,
  WIDGET_EVENT_RETENTION_DAYS,
  type PurgeOptions,
} from '../src/retention.js';

/**
 * The retention purge (P7-07): which winery, which cutoff, how many passes,
 * and the dry run. The statements themselves run against Postgres in
 * `packages/db/test/retention.integration.test.ts`.
 */

const NOW = new Date('2026-10-17T02:15:00Z');
const DAY = 86_400_000;

const tenant = (id: string) => ({ id, createdAt: new Date('2026-01-01T00:00:00Z') });

/** Ports that record what they were asked and delete `left` rows a batch at a time. */
const recording = (
  retention: Record<string, number | null> = {},
  left: Record<string, number> = {},
) => {
  const asked: string[] = [];
  const remaining = { ...left };
  const take = (key: string, limit: number): number => {
    const batch = Math.min(limit, remaining[key] ?? 0);

    remaining[key] = (remaining[key] ?? 0) - batch;

    return batch;
  };

  const options: PurgeOptions = {
    now: () => NOW,
    listTenants: () => Promise.resolve(Object.keys(retention).map(tenant)),
    readRetention: (id) => Promise.resolve(retention[id] ?? null),
    purgeConversations: (id, before) => (limit) => {
      asked.push(`conversations ${id} ${before.toISOString()} ${String(limit)}`);

      return Promise.resolve(take(`c:${id}`, limit));
    },
    purgeEvents: (id, before) => (limit) => {
      asked.push(`events ${id} ${before.toISOString()} ${String(limit)}`);

      return Promise.resolve(take(`e:${id}`, limit));
    },
    countPurgeable: (id, before) => {
      asked.push(
        `count ${id} ${before.conversations.toISOString()} ${before.events.toISOString()}`,
      );

      return Promise.resolve({
        conversations: remaining[`c:${id}`] ?? 0,
        events: remaining[`e:${id}`] ?? 0,
      });
    },
  };

  return { asked, options, remaining };
};

describe('the cutoffs', () => {
  it('keeps transcripts ninety days unless a winery chose otherwise', () => {
    expect(DEFAULT_TRANSCRIPT_RETENTION_DAYS).toBe(90);
    expect(transcriptCutoff(NOW, null)).toEqual(new Date(NOW.getTime() - 90 * DAY));
    expect(transcriptCutoff(NOW, 30)).toEqual(new Date(NOW.getTime() - 30 * DAY));
  });

  it('keeps widget events thirteen months and a bit, for everybody', () => {
    expect(WIDGET_EVENT_RETENTION_DAYS).toBe(400);
    expect(eventCutoff(NOW)).toEqual(new Date(NOW.getTime() - 400 * DAY));
  });
});

describe('a run', () => {
  it('purges each winery by its own period, and every winery’s events by the same horizon', async () => {
    const { asked, options } = recording({ a: null, b: 30 });

    await purgeRetained({ ...options, limit: 100 });

    const ninety = new Date(NOW.getTime() - 90 * DAY).toISOString();
    const thirty = new Date(NOW.getTime() - 30 * DAY).toISOString();
    const events = new Date(NOW.getTime() - 400 * DAY).toISOString();

    expect(asked).toEqual([
      `conversations a ${ninety} 100`,
      `events a ${events} 100`,
      `conversations b ${thirty} 100`,
      `events b ${events} 100`,
    ]);
  });

  it('cuts every winery at the same instant, however long the run takes', async () => {
    let at = NOW.getTime();
    const { asked, options } = recording({ a: null, b: null });

    await purgeRetained({
      ...options,
      now: () => {
        const instant = new Date(at);

        at += DAY;

        return instant;
      },
    });

    const cutoffs = new Set(
      asked.filter((line) => line.startsWith('conversations')).map((line) => line.split(' ')[2]),
    );

    expect(cutoffs.size).toBe(1);
  });

  it('adds up what it deleted, batch after batch, until a batch comes back short', async () => {
    const { asked, options } = recording({ a: null }, { 'c:a': 5, 'e:a': 2 });

    const result = await purgeRetained({ ...options, limit: 2, maxPasses: 10 });

    expect(result).toMatchObject({ tenants: 1, conversations: 5, events: 2, drained: true });
    /* Two, two, one: the short third batch is the end. Then two, and a short nought. */
    expect(asked.filter((line) => line.startsWith('conversations'))).toHaveLength(3);
    expect(asked.filter((line) => line.startsWith('events'))).toHaveLength(2);
  });

  it('stops at the pass cap and says it left some behind, for the next night', async () => {
    const { options, remaining } = recording({ a: null }, { 'c:a': 100 });

    const result = await purgeRetained({ ...options, limit: 10, maxPasses: 3 });

    expect(result).toMatchObject({ conversations: 30, drained: false });
    expect(remaining['c:a']).toBe(70);
  });

  it('carries on past a winery that fails, and counts it', async () => {
    const boom = new Error('db down');
    const { asked, options } = recording({ a: null, b: null }, { 'c:b': 1 });

    const result = await purgeRetained({
      ...options,
      readRetention: (id) => (id === 'a' ? Promise.reject(boom) : Promise.resolve(null)),
    });

    expect(result).toMatchObject({ tenants: 2, conversations: 1, failed: 1, firstFailure: boom });
    expect(asked.some((line) => line.includes(' a '))).toBe(false);
  });
});

describe('a dry run', () => {
  it('counts what would go, by the same cutoffs, and deletes nothing', async () => {
    const { asked, options, remaining } = recording({ a: null, b: 30 }, { 'c:a': 3, 'e:b': 4 });

    const result = await purgeRetained({ ...options, dryRun: true });

    expect(result).toMatchObject({ dryRun: true, conversations: 3, events: 4, failed: 0 });
    expect(asked.every((line) => line.startsWith('count'))).toBe(true);
    expect(asked).toEqual([
      `count a ${new Date(NOW.getTime() - 90 * DAY).toISOString()} ${new Date(NOW.getTime() - 400 * DAY).toISOString()}`,
      `count b ${new Date(NOW.getTime() - 30 * DAY).toISOString()} ${new Date(NOW.getTime() - 400 * DAY).toISOString()}`,
    ]);
    expect(remaining).toEqual({ 'c:a': 3, 'e:b': 4 });
  });
});

describe('the handler', () => {
  it('logs one line that is also its metrics, counting the run and what it purged', async () => {
    const lines: string[] = [];
    const { options } = recording({ a: null }, { 'c:a': 2, 'e:a': 3 });

    await handler(undefined, undefined, { ...options, log: (line) => lines.push(line) });

    const line = JSON.parse(lines[0] ?? '{}') as Record<string, unknown> & {
      _aws: { CloudWatchMetrics: { Namespace: string; Metrics: { Name: string }[] }[] };
    };

    expect(lines).toHaveLength(1);
    expect(line).toMatchObject({
      event: 'retention.completed',
      Runs: 1,
      PurgedRows: 5,
      conversations: 2,
      events: 3,
      drained: true,
    });
    expect(line._aws.CloudWatchMetrics[0]?.Namespace).toBe('Catalogorosso/Retention');
    expect(line._aws.CloudWatchMetrics[0]?.Metrics.map((metric) => metric.Name)).toEqual([
      'Runs',
      'PurgedRows',
    ]);
  });

  it('runs dry when asked to, and a dry run does not count as a night’s run', async () => {
    const lines: string[] = [];
    const { asked, options } = recording({ a: null }, { 'c:a': 2 });

    const result = await handler({ dryRun: true }, undefined, {
      ...options,
      log: (line) => lines.push(line),
    });

    expect(result.dryRun).toBe(true);
    expect(asked.every((line) => line.startsWith('count'))).toBe(true);
    expect(JSON.parse(lines[0] ?? '{}')).toMatchObject({
      event: 'retention.dry_run',
      Runs: 0,
      PurgedRows: 0,
      conversations: 2,
    });
  });

  it.each([[{ dryRun: 'yes' }], [{ dryRun: 1 }], [null], ['dryRun']])(
    'deletes for real unless asked plainly for a dry run: %j',
    async (event) => {
      const { options } = recording({ a: null }, { 'c:a': 1 });

      const result = await handler(event, undefined, { ...options, log: () => undefined });

      expect(result).toMatchObject({ dryRun: false, conversations: 1 });
    },
  );

  it('logs before it fails, so a failing night still reports that it ran', async () => {
    const log = vi.fn();
    const { options } = recording({ a: null });

    await expect(
      handler(undefined, undefined, {
        ...options,
        readRetention: () => Promise.reject(new Error('db down')),
        log,
      }),
    ).rejects.toThrow(PurgeFailedError);
    expect(log).toHaveBeenCalledTimes(1);
  });

  it('writes the metric the alarm watches', () => {
    // infra/test/retention-config.test.ts pins the same strings from its side.
    expect([RETENTION_METRIC_NAMESPACE, RETENTION_RUNS_METRIC, RETENTION_PURGED_METRIC]).toEqual([
      'Catalogorosso/Retention',
      'Runs',
      'PurgedRows',
    ]);
    expect(
      JSON.parse(
        metricLine(
          { dryRun: false, tenants: 0, conversations: 0, events: 0, drained: true, failed: 0 },
          'dev',
          1,
        ),
      ),
    ).toMatchObject({ Stage: 'dev', Runs: 1, PurgedRows: 0 });
  });
});
