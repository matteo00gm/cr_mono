import { describe, expect, it } from 'vitest';

import {
  CLAIM_ALREADY_YOURS,
  CLAIM_NOTICE_HOURS,
  CLAIM_NOTICED,
  CLAIM_RACED,
  CLAIM_TRANSFERRED,
  CLAIM_WITHDRAWN,
  claimVerifyLimitKey,
} from '../src/domain-claims.js';

/**
 * What a claimant is told (P4-18).
 *
 * In this package's own suite rather than only through the API's, because that
 * one imports the built package — a mutation run only sees a package whose own
 * suite runs against its source (P4-06's note).
 */

const MESSAGES = [
  CLAIM_TRANSFERRED,
  CLAIM_NOTICED,
  CLAIM_WITHDRAWN,
  CLAIM_ALREADY_YOURS,
  CLAIM_RACED,
];

describe('what a claimant is told', () => {
  it.each(MESSAGES)('names nobody: %s', (message) => {
    /* Proving control of a zone entitles a seller to the origin, not to learn
     * who our customer was. */
    expect(message).not.toMatch(/tenant|winery|customer|workspace|owner/iu);
  });

  it('gives the notice its length, the one the settlement is handed', () => {
    expect(CLAIM_NOTICE_HOURS).toBe(72);
    expect(CLAIM_NOTICED).toContain('72 hours');
    expect(CLAIM_NOTICED).toMatch(/moves to your account automatically/u);
  });

  it('sends a seller whose claim was withdrawn somewhere', () => {
    expect(CLAIM_WITHDRAWN).toMatch(/contact support/u);
  });

  it('says the transfer is done, and what that means', () => {
    expect(CLAIM_TRANSFERRED).toMatch(/on your account now/u);
    expect(CLAIM_ALREADY_YOURS).toMatch(/already on your account/u);
    expect(CLAIM_RACED).toMatch(/check again/iu);
  });
});

describe('the claim verification allowance', () => {
  it('is counted per claim, apart from a domain’s own', () => {
    expect(claimVerifyLimitKey('c1')).toBe('claim-verify:c1');
  });
});
