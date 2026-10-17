import {
  RETENTION_METRIC_NAMESPACE as WORKER_NAMESPACE,
  RETENTION_RUNS_METRIC as WORKER_RUNS,
} from '../../apps/worker/src/retention.js';
import { describe, expect, it } from 'vitest';

import {
  RETENTION_METRIC_NAMESPACE,
  RETENTION_RUNS_METRIC,
  RETENTION_SCHEDULE,
  RETENTION_SILENCE_SECONDS,
  RETENTION_TIMEOUT_SECONDS,
} from '../retention-config.js';
import { ROLLUP_SCHEDULE } from '../rollup-config.js';

/**
 * The retention purge's schedule, timeout and alarm (P7-07). Each fails without
 * an error when it is wrong: a metric name that drifts from the worker's leaves
 * the alarm watching a metric that never arrives — and that alarm is the only
 * thing that notices a purge which has stopped.
 */

describe('the retention purge', () => {
  it('runs nightly, after the rollup has read yesterday', () => {
    expect(RETENTION_SCHEDULE).toBe('cron(15 2 * * ? *)');
    expect(ROLLUP_SCHEDULE).toBe('cron(30 1 * * ? *)');
  });

  it('has five minutes, and alarms on a day with no run', () => {
    expect(RETENTION_TIMEOUT_SECONDS).toBe(300);
    expect(RETENTION_SILENCE_SECONDS).toBe(86_400);
  });

  it('watches the metric the worker writes', () => {
    expect(RETENTION_METRIC_NAMESPACE).toBe(WORKER_NAMESPACE);
    expect(RETENTION_RUNS_METRIC).toBe(WORKER_RUNS);
  });
});
