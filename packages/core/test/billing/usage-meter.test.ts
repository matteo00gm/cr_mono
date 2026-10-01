import { describe, expect, it } from 'vitest';

import { periodEnd, projectMonth, thresholdReached } from '../../src/billing/usage-meter.js';

/**
 * The month as a seller reads it (P5-12): the two notices' thresholds, and the
 * end-of-month projection.
 */

describe('the thresholds', () => {
  it.each<[number, 80 | 100 | undefined]>([
    [790, undefined],
    [799, undefined],
    [800, 80],
    [990, 80],
    [999, 80],
    [1_000, 100],
    [1_010, 100],
  ])('%i of 1,000 messages reaches %s', (used, threshold) => {
    expect(thresholdReached(used, 1_000)).toBe(threshold);
  });

  it('counts what was bought: a spent plan with a top-up is not spent', () => {
    expect(thresholdReached(1_500, 1_500)).toBe(100);
    expect(thresholdReached(1_500, 2_500)).toBeUndefined();
  });

  it('calls an allowance of nothing spent', () => {
    expect(thresholdReached(0, 0)).toBe(100);
  });
});

describe('when the month ends', () => {
  it('is the first instant of the next one, in UTC like the ledger', () => {
    expect(periodEnd(new Date('2026-10-17T22:30:00Z'))).toEqual(new Date('2026-11-01T00:00:00Z'));
    expect(periodEnd(new Date('2026-12-31T23:59:59Z'))).toEqual(new Date('2027-01-01T00:00:00Z'));
  });
});

describe('the projection', () => {
  it('carries the rate so far to the end of the month', () => {
    /* Ten days into a thirty-one day month: 400 is 40 a day, and 1,240 by the end. */
    expect(projectMonth(400, new Date('2026-10-11T00:00:00Z'))).toBe(1_240);
  });

  it('is the month itself on its last instant', () => {
    expect(projectMonth(900, new Date('2026-09-30T23:59:59.999Z'))).toBe(900);
  });

  it('is sane in the first hours of a month, taking the rate over a day at least', () => {
    /* Six hours in: twelve messages is not two thousand by the end. */
    expect(projectMonth(12, new Date('2026-10-01T06:00:00Z'))).toBe(372);
  });

  it('never projects less than what is already used', () => {
    expect(projectMonth(0, new Date('2026-10-01T00:00:00Z'))).toBe(0);
    expect(projectMonth(5, new Date('2026-02-01T00:00:01Z'))).toBe(140);
  });

  it('knows February', () => {
    expect(projectMonth(140, new Date('2027-02-15T00:00:00Z'))).toBe(280);
  });
});
