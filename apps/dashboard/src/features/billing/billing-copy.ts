import { PLAN_IDS, PLANS, TOP_UP, type PlanId } from '@catalogorosso/core/plans';

/**
 * The words and numbers the billing screens share (P5-12): one place for the
 * prices a seller is shown, read from `plans.ts` like the Stripe catalogue is,
 * so a button can never name a price the Checkout page will not charge.
 */

/** `€15`, `€29`: whole euros, as the price list says them. */
export const euros = (cents: number): string =>
  `€${cents % 100 === 0 ? String(cents / 100) : (cents / 100).toFixed(2)}`;

/** `1.230`: the Italian grouping, four digits included. */
export const count = (n: number): string =>
  new Intl.NumberFormat('it-IT', { useGrouping: 'always' }).format(n);

/** The day the month's messages reset, as an Italian reads a date. */
export const resetDay = (iso: string): string =>
  new Intl.DateTimeFormat('it-IT', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(new Date(iso));

/** The plan a winery would move up to, or the first for one with none. */
export const nextPlan = (plan: PlanId | null): PlanId | undefined =>
  plan === null ? PLAN_IDS[0] : PLAN_IDS[PLAN_IDS.indexOf(plan) + 1];

export const TOP_UP_LABEL = `Acquista Ricarica +${count(TOP_UP.messages)} messaggi (${euros(TOP_UP.amountCents)})`;

export const upgradeLabel = (plan: PlanId): string =>
  `Passa al piano ${PLANS[plan].name} (${euros(PLANS[plan].amountCents)}/mese)`;
