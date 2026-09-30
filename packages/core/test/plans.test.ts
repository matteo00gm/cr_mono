import type { readTenantPlan } from '@catalogorosso/db';
import { WIDGET_LIMITS, type PlanTier } from '@catalogorosso/security';
import { describe, expect, expectTypeOf, it } from 'vitest';

import { DOMAIN_CAPS } from '../src/domains.js';
import { MAX_IMPORT_ROWS } from '../src/import-limits.js';
import { PLAN_IDS, PLANS, TRIAL, planForLookupKey, type PlanId } from '../src/plans.js';

/**
 * The plans, and every copy of them that cannot import this file (P5-01).
 *
 * **Pinned by value first**, because the numbers are a commercial decision
 * (Open Decisions 2b) and a test that only compared copies with each other
 * would pass for any price at all. Then every copy that enforces one is held
 * to it: the limiter's monthly cap lives in `packages/security`, below core in
 * the build graph, and the import ceiling is a browser subpath that imports
 * nothing — so a change here that forgets either fails here.
 */

const plans = PLAN_IDS.map((id) => PLANS[id]);

/** The `tenant_plan` enum's values, as the database package types what it reads. */
type DatabasePlan = NonNullable<Awaited<ReturnType<typeof readTenantPlan>>>;

describe('the plans we sell', () => {
  it('are Cantina at €29 and E-commerce at €79 a month (Open Decisions 2b)', () => {
    expect(
      plans.map(({ id, amountCents, currency, interval }) => ({
        id,
        amountCents,
        currency,
        interval,
      })),
    ).toEqual([
      { id: 'CANTINA', amountCents: 2_900, currency: 'eur', interval: 'month' },
      { id: 'ECOMMERCE', amountCents: 7_900, currency: 'eur', interval: 'month' },
    ]);
  });

  it('allow what the table says, and the trial what it says', () => {
    expect(
      plans.map(({ messagesPerMonth, skuCap, productionDomains }) => ({
        messagesPerMonth,
        skuCap,
        productionDomains,
      })),
    ).toEqual([
      { messagesPerMonth: 1_500, skuCap: 300, productionDomains: 1 },
      { messagesPerMonth: 6_000, skuCap: 2_500, productionDomains: 2 },
    ]);
    expect(TRIAL).toEqual({ name: 'trial', messagesPerMonth: 150, productionDomains: 1 });
  });

  it('file each plan under its own id', () => {
    for (const id of PLAN_IDS) expect(PLANS[id].id).toBe(id);
  });

  it('give every price a whole, positive amount and every limit a whole, positive number', () => {
    /*
     * "A Stripe price without limits fails CI" (P5-01): the setup script
     * creates prices from this file and nowhere else, so a plan with a missing
     * or nonsense limit is the only way to sell one.
     */
    for (const plan of plans) {
      for (const value of [
        plan.amountCents,
        plan.messagesPerMonth,
        plan.skuCap,
        plan.productionDomains,
      ]) {
        expect(Number.isSafeInteger(value) && value > 0, `${plan.id}: ${String(value)}`).toBe(true);
      }
    }
  });

  it('use a distinct lookup key each, shaped as Stripe accepts one', () => {
    const keys = plans.map((plan) => plan.lookupKey);

    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) expect(key).toMatch(/^[a-z0-9_]{1,200}$/u);
  });
});

describe('a lookup key read back', () => {
  it('names the plan it belongs to', () => {
    for (const plan of plans) expect(planForLookupKey(plan.lookupKey)).toBe(plan.id);
  });

  it('names nothing for a key that is not ours, rather than the nearest plan', () => {
    expect(planForLookupKey('cantina_yearly_eur')).toBeUndefined();
    expect(planForLookupKey(null)).toBeUndefined();
    expect(planForLookupKey(undefined)).toBeUndefined();
  });
});

describe('every copy that enforces a plan', () => {
  it('caps the month in the limiter at the plan’s allowance (packages/security)', () => {
    expect(WIDGET_LIMITS.messagesPerMonth).toEqual({
      CANTINA: PLANS.CANTINA.messagesPerMonth,
      ECOMMERCE: PLANS.ECOMMERCE.messagesPerMonth,
      none: TRIAL.messagesPerMonth,
    });
  });

  it('caps production domains at the plan’s allowance', () => {
    expect(DOMAIN_CAPS).toEqual({
      CANTINA: PLANS.CANTINA.productionDomains,
      ECOMMERCE: PLANS.ECOMMERCE.productionDomains,
      none: TRIAL.productionDomains,
    });
  });

  it('caps one import at the largest catalogue any plan allows (a subpath that imports nothing)', () => {
    expect(MAX_IMPORT_ROWS).toBe(Math.max(...plans.map((plan) => plan.skuCap)));
  });

  it('agrees with the database enum and the limiter’s tiers on which plans exist', () => {
    expectTypeOf<DatabasePlan>().toEqualTypeOf<PlanId>();
    expectTypeOf<Exclude<PlanTier, 'none'>>().toEqualTypeOf<PlanId>();
  });
});
