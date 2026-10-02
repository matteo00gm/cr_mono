import { describe, expect, it } from 'vitest';

import { MIN_QUERY_CONVERSATIONS, TOP_LIMIT } from '../../src/analytics/top.js';

/**
 * The two numbers the top panels are built on (P6-03). What they select is
 * counted against Postgres in `top.integration.test.ts`.
 */

describe('the threshold', () => {
  it('is three conversations: a trend, not one visitor’s phrasing', () => {
    expect(MIN_QUERY_CONVERSATIONS).toBe(3);
  });
});

describe('the length of a list', () => {
  it('is ten', () => {
    expect(TOP_LIMIT).toBe(10);
  });
});
