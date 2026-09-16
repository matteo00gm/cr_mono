import { describe, expect, it } from 'vitest';

import {
  assertSweepFitsSchedule,
  scheduleIntervalSeconds,
  SWEEP_DELETED_METRIC,
  SWEEP_METRIC_NAMESPACE,
  SWEEP_SCHEDULE,
  SWEEP_SILENCE_SECONDS,
  SWEEP_TIMEOUT_SECONDS,
} from '../sweep-config.js';

/**
 * The sweep's schedule, timeout and alarm (P2-14).
 *
 * Each of these fails without an error when it is wrong. A timeout past the
 * interval overlaps two runs; an alarm window shorter than a few runs alarms on
 * a quiet quarter of an hour; a metric name that drifts from the one the worker
 * writes leaves an alarm watching a metric that never arrives, which reads as a
 * sweep that deleted nothing — or, with missing data treated as fine, as one
 * that always works.
 */

describe('the schedule', () => {
  it('runs every fifteen minutes, as the row asks', () => {
    expect(SWEEP_SCHEDULE).toBe('rate(15 minutes)');
    expect(scheduleIntervalSeconds()).toBe(900);
  });

  it('reads the rates EventBridge takes, and refuses what it cannot read', () => {
    expect(scheduleIntervalSeconds('rate(1 minute)')).toBe(60);
    expect(scheduleIntervalSeconds('rate(2 hours)')).toBe(7_200);
    expect(() => scheduleIntervalSeconds('cron(0/15 * * * ? *)')).toThrow(/not a rate/);
  });
});

describe('a run', () => {
  it('ends before the next one starts', () => {
    expect(() => {
      assertSweepFitsSchedule();
    }).not.toThrow();
    expect(SWEEP_TIMEOUT_SECONDS).toBeLessThan(scheduleIntervalSeconds());
  });

  it('is refused a timeout that could overlap the next run', () => {
    expect(() => {
      assertSweepFitsSchedule(900, 'rate(15 minutes)');
    }).toThrow(/could overlap/);
    expect(() => {
      assertSweepFitsSchedule(899, 'rate(15 minutes)');
    }).not.toThrow();
  });
});

describe('the alarm', () => {
  it('waits a day, the row’s threshold, which is many runs', () => {
    expect(SWEEP_SILENCE_SECONDS).toBe(86_400);
    expect(SWEEP_SILENCE_SECONDS / scheduleIntervalSeconds()).toBeGreaterThanOrEqual(96);
  });

  it('watches the metric the worker writes', () => {
    // The worker's own test pins the same two strings from its side.
    expect([SWEEP_METRIC_NAMESPACE, SWEEP_DELETED_METRIC]).toEqual([
      'Catalogorosso/Sweep',
      'DeletedRows',
    ]);
  });
});
