import { describe, expect, it } from 'vitest';

import {
  ROLLUP_METRIC_NAMESPACE,
  ROLLUP_RUNS_METRIC,
  ROLLUP_SCHEDULE,
  ROLLUP_SILENCE_SECONDS,
  ROLLUP_TIMEOUT_SECONDS,
} from '../rollup-config.js';

/**
 * The nightly rollup's schedule, timeout and alarm (P5-13). Each fails without
 * an error when it is wrong: a metric name that drifts from the worker's leaves
 * the alarm watching a metric that never arrives.
 */

describe('the rollup', () => {
  it('runs nightly, after every seller’s midnight', () => {
    expect(ROLLUP_SCHEDULE).toBe('cron(30 1 * * ? *)');
  });

  it('has room for a slow database inside a run', () => {
    expect(ROLLUP_TIMEOUT_SECONDS).toBe(300);
  });

  it('alarms on a night with no run, which a day-long window always holds one of', () => {
    expect(ROLLUP_SILENCE_SECONDS).toBe(86_400);
  });

  it('watches the metric the worker writes', () => {
    // The worker's own test pins the same two strings from its side.
    expect([ROLLUP_METRIC_NAMESPACE, ROLLUP_RUNS_METRIC]).toEqual(['Catalogorosso/Rollup', 'Runs']);
  });
});
