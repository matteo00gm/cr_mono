import { describe, expect, it } from 'vitest';

import { MIN_QUERY_CONVERSATIONS, TOP_LIMIT } from '../../src/analytics/top.js';

/**
 * The two numbers the top panels are built on (P6-03). What they select is
 * counted against Postgres in `top.integration.test.ts`.
 */

describe('the threshold', () => {
  it('is three conversations: enough that one visitor’s own words never reach the list', () => {
    /*
     * Lowering it is a privacy decision, not a tuning one: at one, a name or
     * an address typed into the chat is a row on a seller's screen.
     */
    expect(MIN_QUERY_CONVERSATIONS).toBe(3);
  });
});

describe('the length of a list', () => {
  it('is ten', () => {
    expect(TOP_LIMIT).toBe(10);
  });
});
