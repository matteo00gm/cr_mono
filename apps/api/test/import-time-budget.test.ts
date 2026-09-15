import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { API_TIMEOUT_SECONDS, IMPORT_TIME_BUDGET_MS } from '@catalogorosso/core';
import { IMPORT_CLAIM_EXPIRES_AFTER_SECONDS } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

/**
 * The import's clocks against the function they run in (review fix, P1-25, P1-26).
 *
 * Three numbers live in three places and only mean anything together: the API
 * function's timeout in `infra/api.ts`, the time an import may spend on batches,
 * and how long an unfinished claim is taken to be still running. Each was
 * reasonable alone when the review found the pair that disagreed — a claim
 * expiry sized to fifteen minutes on a function killed at ten seconds.
 *
 * Nothing under `infra/` can be imported outside a deploy, so the timeout is
 * read out of the source. A test that parses a file is a blunt instrument, and
 * it is still the only one that fails the day somebody raises the timeout and
 * forgets the budget.
 */

const INFRA_API = fileURLToPath(new URL('../../../infra/api.ts', import.meta.url));

describe('the import clocks', () => {
  it('restate the timeout infra/api.ts actually sets', () => {
    const timeouts = [...readFileSync(INFRA_API, 'utf8').matchAll(/timeout: '(\d+) seconds'/g)].map(
      ([, seconds]) => Number(seconds),
    );

    expect(timeouts).toEqual([API_TIMEOUT_SECONDS]);
  });

  it('leave the budget room inside the timeout for the body, one slow batch and the result', () => {
    // Parsing up to 5 MB of rows comes before the budget's batches, and storing the answer after.
    expect(IMPORT_TIME_BUDGET_MS).toBeGreaterThan(0);
    expect(IMPORT_TIME_BUDGET_MS).toBeLessThanOrEqual(API_TIMEOUT_SECONDS * 1_000 * 0.6);
  });

  it('expire an unfinished claim only once the function that made it must be gone', () => {
    expect(IMPORT_CLAIM_EXPIRES_AFTER_SECONDS).toBeGreaterThanOrEqual(API_TIMEOUT_SECONDS * 2);
    // And not the fifteen minutes it was: a seller retrying a cut-off import waits for this.
    expect(IMPORT_CLAIM_EXPIRES_AFTER_SECONDS).toBeLessThanOrEqual(60);
  });
});
