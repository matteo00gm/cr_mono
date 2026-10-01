import { describe, expect, it } from 'vitest';

import { InvalidRequestError } from '../../src/errors.js';
import {
  analyticsRange,
  DEFAULT_RANGE_DAYS,
  MAX_RANGE_DAYS,
  RANGE_EXPECTED,
} from '../../src/analytics/range.js';

/**
 * The days a panel covers (P6-02): whole UTC days, both ends included, a year
 * at most.
 */

const NOW = new Date('2026-10-01T15:30:00.000Z');

const refused = (asked: { from?: string; to?: string }) => () => analyticsRange(asked, NOW);

describe('the default', () => {
  it('is the last thirty days, today included', () => {
    expect(analyticsRange({}, NOW)).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      start: new Date('2026-09-02T00:00:00.000Z'),
      end: new Date('2026-10-02T00:00:00.000Z'),
    });
    expect(DEFAULT_RANGE_DAYS).toBe(30);
  });

  it('counts back thirty days from a chosen last day', () => {
    expect(analyticsRange({ to: '2026-03-31' }, NOW).from).toBe('2026-03-02');
  });

  it('ends today when only the first day is chosen', () => {
    expect(analyticsRange({ from: '2026-09-28' }, NOW)).toMatchObject({
      from: '2026-09-28',
      to: '2026-10-01',
    });
  });

  it('reads today in UTC, not the clock of whoever runs it', () => {
    /* Half past midnight in Rome is still the day before in UTC. */
    expect(analyticsRange({}, new Date('2026-09-30T22:30:00.000Z')).to).toBe('2026-09-30');
  });

  it('defaults to the real clock', () => {
    expect(analyticsRange({}).to).toBe(new Date().toISOString().slice(0, 10));
  });
});

describe('a chosen range', () => {
  it('includes both of its days, as [start, end)', () => {
    const range = analyticsRange({ from: '2026-09-01', to: '2026-09-01' }, NOW);

    expect(range.start).toEqual(new Date('2026-09-01T00:00:00.000Z'));
    expect(range.end).toEqual(new Date('2026-09-02T00:00:00.000Z'));
  });

  it(`may be ${String(MAX_RANGE_DAYS)} days, and no more`, () => {
    expect(analyticsRange({ from: '2025-10-01', to: '2026-10-01' }, NOW).from).toBe('2025-10-01');
    expect(refused({ from: '2025-09-30', to: '2026-10-01' })).toThrow(RANGE_EXPECTED);
    expect(MAX_RANGE_DAYS).toBe(366);
  });

  it('is refused backwards', () => {
    expect(refused({ from: '2026-09-02', to: '2026-09-01' })).toThrow(InvalidRequestError);
  });

  it.each([
    ['a timestamp', { from: '2026-09-01T00:00:00Z' }],
    ['a day that does not exist', { from: '2026-02-30' }],
    ['no zero padding', { to: '2026-9-1' }],
    ['words', { to: 'yesterday' }],
    ['nothing at all', { from: '' }],
  ])('is refused for %s, saying what is wanted', (_label, asked) => {
    expect(refused(asked)).toThrow(RANGE_EXPECTED);
  });

  it('refuses as a request problem, which the caller is told', () => {
    expect(refused({ to: 'nope' })).toThrow(InvalidRequestError);
  });
});
