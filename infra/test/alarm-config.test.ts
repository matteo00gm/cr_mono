import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  QUOTA_REFUSALS_METRIC as API_QUOTA_REFUSALS,
  REFUSED_ORIGINS_METRIC as API_REFUSED_ORIGINS,
  WIDGET_METRIC_NAMESPACE as API_WIDGET_NAMESPACE,
} from '../../apps/api/src/metrics.js';
import {
  ROLLUP_METRIC_NAMESPACE as WORKER_ROLLUP_NAMESPACE,
  ROLLUP_TENANT_COST_METRIC as WORKER_TENANT_COST,
} from '../../apps/worker/src/rollup.js';
import { describe, expect, it } from 'vitest';

import {
  ALARMS,
  CHAT_P95_MS,
  CHAT_P95_PERIOD_SECONDS,
  CHAT_P95_PERIODS,
  DATABASE_CPU_PERCENT,
  databaseConnectionsThreshold,
  ERROR_RATE_MIN_REQUESTS,
  ERROR_RATE_THRESHOLD,
  errorRateExpression,
  QUEUE_AGE_SECONDS,
  QUOTA_REFUSALS_METRIC,
  QUOTA_REFUSALS_THRESHOLD,
  REFUSED_ORIGINS_METRIC,
  REFUSED_ORIGINS_THRESHOLD,
  sumExpression,
  TENANT_COST_METRIC,
  TENANT_DAILY_COST_MICROS,
  WIDGET_METRIC_NAMESPACE,
} from '../alarm-config.js';
import { CONNECTIONS } from '../queue-config.js';
import { ROLLUP_METRIC_NAMESPACE } from '../rollup-config.js';

/**
 * The alarms (P7-02): the part of them a test can hold.
 *
 * Whether an alarm fires is a thing to force in a review stage — the runbook
 * says how, for each. What is here is everything short of that, and each of
 * these has gone wrong somewhere before it was checked: an alarm on a metric
 * nobody writes, an alarm that fires and tells nobody, an alarm whose email
 * says something is wrong and not what to do.
 */

const INFRA = join(import.meta.dirname, '..');
const RUNBOOK = join(INFRA, '../docs/runbooks/alarms.md');

/** Every file that could declare an alarm, with its source. */
const sources = readdirSync(INFRA)
  .filter((name) => name.endsWith('.ts'))
  .map((name) => ({ name, source: readFileSync(join(INFRA, name), 'utf8') }));

const DECLARED = /new aws\.cloudwatch\.MetricAlarm\(/gu;

describe('the names both halves use', () => {
  it('agree, because an alarm on a metric nobody writes is a green alarm for ever', () => {
    /*
     * `infra/` cannot be imported by the application and the application is
     * not imported by `infra/`, so each name is declared twice. P2-28's alarm
     * shows what a metric that never arrives looks like: nothing at all.
     */
    expect(WIDGET_METRIC_NAMESPACE).toBe(API_WIDGET_NAMESPACE);
    expect(REFUSED_ORIGINS_METRIC).toBe(API_REFUSED_ORIGINS);
    expect(QUOTA_REFUSALS_METRIC).toBe(API_QUOTA_REFUSALS);
    expect(TENANT_COST_METRIC).toBe(WORKER_TENANT_COST);
    expect(ROLLUP_METRIC_NAMESPACE).toBe(WORKER_ROLLUP_NAMESPACE);
  });
});

describe('every alarm the stack declares', () => {
  /** The logical name of each alarm: the first argument, wherever one is written. */
  const named = sources.flatMap(({ source }) =>
    [...source.matchAll(/(?:MetricAlarm|errorRateAlarm)\(\s*'([A-Za-z0-9]+)'/gu)].map(
      (match) => match[1] ?? '',
    ),
  );

  it('is on the list, and the list names nothing that is not declared', () => {
    expect([...named].sort()).toEqual([...ALARMS].sort());
    expect(new Set(named).size).toBe(named.length);
    expect(ALARMS.length).toBeGreaterThanOrEqual(16);
  });

  it('is routed somewhere, so that firing is not the same as nobody knowing', () => {
    /*
     * Five alarms existed before P7-02 and went nowhere: each said in a comment
     * that routing was this row's. One `...notify` per declaration, file by
     * file, so the next alarm written cannot be the sixth.
     */
    const unrouted = sources
      .map(({ name, source }) => ({
        name,
        declared: source.match(DECLARED)?.length ?? 0,
        routed: source.match(/\.\.\.notify,/gu)?.length ?? 0,
      }))
      .filter(({ declared }) => declared > 0)
      .filter(({ declared, routed }) => declared !== routed);

    expect(unrouted).toEqual([]);
    expect(
      sources.reduce((sum, { source }) => sum + (source.match(DECLARED)?.length ?? 0), 0),
    ).toBe(
      /* `errorRateAlarm` declares one and is called for two. */
      ALARMS.length - 1,
    );
  });

  it('is told about when it clears as well as when it fires', () => {
    const alerting = sources.find(({ name }) => name === 'alerting.ts')?.source ?? '';

    expect(alerting).toMatch(/alarmActions: \[topic\.arn\]/u);
    expect(alerting).toMatch(/okActions: \[topic\.arn\]/u);
    expect(alerting).toMatch(/protocol: 'email'/u);
  });

  it('is in the stack at all: the file that holds most of them is loaded', () => {
    const config = readFileSync(join(INFRA, '../sst.config.ts'), 'utf8');

    expect(config).toContain("await import('./infra/alarms')");
  });
});

describe('the runbook', () => {
  const runbook = readFileSync(RUNBOOK, 'utf8');
  const entries = new Map(
    runbook
      .split(/^## /mu)
      .slice(1)
      .map((entry): [string, string] => {
        const [heading = '', ...body] = entry.split('\n');

        return [heading.trim(), body.join('\n')];
      }),
  );

  it('has an entry for every alarm, and no entry for an alarm that does not exist', () => {
    expect([...entries.keys()].sort()).toEqual([...ALARMS].sort());
  });

  it.each(ALARMS)('says what %s means, what to do, and how to force it once', (alarm) => {
    const entry = entries.get(alarm) ?? '';

    /* An alarm without a response is noise that teaches people to ignore alarms. */
    expect(entry).toMatch(/^\*\*Means:\*\* \S/mu);
    expect(entry).toMatch(/^\*\*Do:\*\* \S/mu);
    expect(entry).toMatch(/^\*\*Force it:\*\* \S/mu);
    expect(entry.length).toBeGreaterThan(200);
  });

  it('names the alarm in every description’s place: the email carries the name, and the entry is under it', () => {
    /* Each alarm also describes itself in a sentence, for an email read on a phone. */
    for (const { source } of sources) {
      const declared = source.match(DECLARED)?.length ?? 0;
      const described = source.match(/alarmDescription:/gu)?.length ?? 0;

      expect(described).toBe(declared);
    }
  });
});

describe('where the lines are drawn', () => {
  it('a twentieth of requests failing, and never on a handful of them', () => {
    expect(ERROR_RATE_THRESHOLD).toBe(0.05);
    expect(ERROR_RATE_MIN_REQUESTS).toBe(20);
    expect(errorRateExpression()).toBe('IF(r >= 20, e / r)');
    expect(errorRateExpression('requests', 'errors', 5)).toBe(
      'IF(requests >= 5, errors / requests)',
    );
  });

  it('one chat turn in twenty over twenty seconds, for a quarter of an hour', () => {
    expect(CHAT_P95_MS).toBe(20_000);
    expect(CHAT_P95_PERIOD_SECONDS * CHAT_P95_PERIODS).toBe(900);
  });

  it('the guards: fifty refused origins in five minutes, twenty spent-month refusals in fifteen', () => {
    expect(REFUSED_ORIGINS_THRESHOLD).toBe(50);
    expect(QUOTA_REFUSALS_THRESHOLD).toBe(20);
  });

  it('a wine waiting a quarter of an hour to be indexed', () => {
    expect(QUEUE_AGE_SECONDS).toBe(900);
  });

  it('a dollar a day for one winery, which no plan sells', () => {
    expect(TENANT_DAILY_COST_MICROS).toBe(1_000_000);
  });

  it('four fifths of the database: its CPU, and the connections it will accept', () => {
    expect(DATABASE_CPU_PERCENT).toBe(80);
    expect(databaseConnectionsThreshold()).toBe(80);
    /* From the budget, so a larger instance moves the line with it. */
    expect(databaseConnectionsThreshold({ ...CONNECTIONS, instanceMax: 405 })).toBe(324);
    /* And above what the API and the worker are allowed between them, or it fires on a busy day. */
    expect(databaseConnectionsThreshold()).toBeGreaterThan(CONNECTIONS.instanceMax / 2);
  });

  it('adds up as many scheduled jobs as there are', () => {
    expect(sumExpression(1)).toBe('e0');
    expect(sumExpression(4)).toBe('e0 + e1 + e2 + e3');
  });
});
