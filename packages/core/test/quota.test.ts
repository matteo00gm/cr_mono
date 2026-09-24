import { describe, expect, it } from 'vitest';

import { checkQuota, OVERAGE_ALLOWANCE, QUOTA_EXCEEDED_MESSAGE } from '../src/quota.js';

/**
 * The monthly plan cap (P2-36).
 *
 * **The boundary is the whole test.** A cap that admits the message at exactly
 * the limit is a free message at every tier, every month, for every tenant —
 * and there is no symptom, because the number a seller sees and the number we
 * bill are both one higher than they should be, consistently.
 *
 * The second thing worth asserting is that being *in* overage and being
 * *refused* are different facts. Collapsing them is how a seller first learns
 * about their overage from an invoice.
 */

const CAP = 1500;

describe('the boundary', () => {
  it('allows the message before the last one', () => {
    expect(checkQuota({ used: CAP - 2, limit: CAP }).allowed).toBe(true);
  });

  it('allows the last message the plan sells', () => {
    // 1,499 already sent means the 1,500th is this one, and the plan sells it.
    expect(checkQuota({ used: CAP - 1, limit: CAP }).allowed).toBe(true);
  });

  it('refuses the one after it', () => {
    /*
     * `used < limit`, not `<=`. The allowance is a count of messages, so a
     * tenant who has sent exactly their cap has had all of them and the next
     * one is the one over. Off by one here is a free month at every tier.
     */
    expect(checkQuota({ used: CAP, limit: CAP }).allowed).toBe(false);
  });

  it('refuses well past it', () => {
    expect(checkQuota({ used: CAP * 3, limit: CAP }).allowed).toBe(false);
  });

  it('refuses a tenant on a plan that sells nothing', () => {
    expect(checkQuota({ used: 0, limit: 0 }).allowed).toBe(false);
  });
});

describe('what the widget is told', () => {
  it('is ok well inside the month', () => {
    expect(checkQuota({ used: 10, limit: CAP }).state).toBe('ok');
  });

  it('warns before it refuses, so a seller can act', () => {
    expect(checkQuota({ used: CAP * 0.9, limit: CAP }).state).toBe('near');
  });

  it('says exceeded from the cap on', () => {
    expect(checkQuota({ used: CAP, limit: CAP }).state).toBe('exceeded');
  });

  it('is three states and never a number', () => {
    // `/v1/widget/config` is world-readable and edge-cached, so a remaining
    // count would let a competitor read a shop's traffic off its own widget.
    const decision = checkQuota({ used: 10, limit: CAP });

    expect(['ok', 'near', 'exceeded']).toContain(decision.state);
  });
});

describe('overage', () => {
  it('allows nothing past the cap at launch', () => {
    // Serving past the cap means billing for it, and there is no overage
    // billing until P5 — so an allowance now is generosity nobody agreed to.
    expect(OVERAGE_ALLOWANCE).toBe(0);
  });

  it('serves into an allowance when one is configured', () => {
    expect(checkQuota({ used: CAP, limit: CAP, overage: 100 }).allowed).toBe(true);
  });

  it('hard stops at the end of the allowance', () => {
    expect(checkQuota({ used: CAP + 100, limit: CAP, overage: 100 }).allowed).toBe(false);
  });

  it('reports being in overage separately from being refused', () => {
    /*
     * Two different facts. A tenant in overage is being served *and* needs
     * telling — §2.3's banner is driven by the first and the refusal by the
     * second, and collapsing them is how a seller first hears about their
     * overage from an invoice.
     */
    const serving = checkQuota({ used: CAP + 10, limit: CAP, overage: 100 });

    expect(serving.allowed).toBe(true);
    expect(serving.inOverage).toBe(true);
  });

  it('is not in overage below the cap', () => {
    expect(checkQuota({ used: CAP - 1, limit: CAP, overage: 100 }).inOverage).toBe(false);
  });
});

describe('what it reports back', () => {
  it('carries the numbers the caller needs to log and to notify', () => {
    expect(checkQuota({ used: 42, limit: CAP })).toMatchObject({ used: 42, limit: CAP });
  });
});

describe('what a refused visitor is told', () => {
  it('says nothing about the plan', () => {
    /*
     * A `DomainError`'s message reaches the caller verbatim (P0-55), and §1.3
     * keeps billing details away from a visitor. Which plan a winery pays for
     * is the seller's business, not the shopper's.
     */
    expect(QUOTA_EXCEEDED_MESSAGE).not.toMatch(/\d/);
    expect(QUOTA_EXCEEDED_MESSAGE.toLowerCase()).not.toContain('plan');
    expect(QUOTA_EXCEEDED_MESSAGE.toLowerCase()).not.toContain('quota');
  });

  it('tells the visitor what to do instead', () => {
    expect(QUOTA_EXCEEDED_MESSAGE).toMatch(/contact the shop/i);
  });
});
