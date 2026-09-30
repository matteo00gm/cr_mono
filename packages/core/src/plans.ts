/**
 * The plans we sell, and everything each one allows (P5-01, Open Decisions 2b).
 *
 * **The single source of truth for what a plan is.** The Stripe catalogue is
 * built from this file by `scripts/stripe-setup.mjs`, so a price cannot exist
 * without the limits that go with it; and the places that enforce a limit read
 * it from here or are held to it by `plans.test.ts`. Two of them cannot import
 * it — `packages/security` sits below core in the build graph, and a browser
 * subpath imports nothing — so their copies are pinned by a test instead, and
 * changing a number here without changing them fails CI.
 *
 * **The lookup key is the contract with Stripe, not the price id.** Prices are
 * immutable there: a new amount is a new price, and the key moves to it. So the
 * code asks Stripe for the price under a key rather than storing an id that
 * goes stale the day a plan is repriced.
 *
 * A file that imports nothing, so the dashboard can take it through a subpath
 * without pulling the `core` barrel into a browser (P1-13's rule).
 */

export const PLAN_IDS = ['CANTINA', 'ECOMMERCE'] as const;

/** The values of the `tenant_plan` enum, which `plans.test.ts` holds equal. */
export type PlanId = (typeof PLAN_IDS)[number];

export interface PlanLimits {
  /** Chat messages a month, with a hard stop at 100% (Open Decisions 2b). */
  readonly messagesPerMonth: number;
  /** Production origins. Staging origins are outside the plan (P4-19). */
  readonly productionDomains: number;
}

export interface Plan extends PlanLimits {
  readonly id: PlanId;
  /** What a seller calls it, and what their invoice says. */
  readonly name: string;
  /** The Stripe price's `lookup_key`. */
  readonly lookupKey: string;
  /** Minor units: €29 is 2900. */
  readonly amountCents: number;
  readonly currency: 'eur';
  readonly interval: 'month';
  /** Wines in the catalogue. Enforced on downgrade by P5-10. */
  readonly skuCap: number;
}

export const PLANS: Readonly<Record<PlanId, Plan>> = {
  CANTINA: {
    id: 'CANTINA',
    name: 'Cantina',
    lookupKey: 'cantina_monthly_eur',
    amountCents: 2_900,
    currency: 'eur',
    interval: 'month',
    messagesPerMonth: 1_500,
    skuCap: 300,
    productionDomains: 1,
  },
  ECOMMERCE: {
    id: 'ECOMMERCE',
    name: 'E-commerce',
    lookupKey: 'ecommerce_monthly_eur',
    amountCents: 7_900,
    currency: 'eur',
    interval: 'month',
    messagesPerMonth: 6_000,
    skuCap: 2_500,
    productionDomains: 2,
  },
};

/**
 * The plan a Stripe price belongs to, read off its lookup key.
 *
 * What a webhook uses to turn a subscription into a plan (P5-05). A key that is
 * not ours is `undefined` rather than a guess: a price somebody clicked into
 * the Dashboard has no limits, and granting it the nearest plan's would sell
 * something `plans.ts` never described.
 */
export const planForLookupKey = (key: string | null | undefined): PlanId | undefined =>
  PLAN_IDS.find((id) => PLANS[id].lookupKey === key);

/**
 * A tenant with no subscription yet, which every tenant is between signup and
 * checkout (Open Decisions 2).
 *
 * **No SKU cap, deliberately undecided.** Nothing enforces a catalogue size per
 * plan until P5-10, and a trial's is a commercial choice nobody has made; the
 * import ceiling (`MAX_IMPORT_ROWS`) is the only bound it has today.
 */
export const TRIAL: PlanLimits & { readonly name: string; readonly days: number } = {
  name: 'trial',
  /** From the first verified domain (P5-05). */
  days: 14,
  messagesPerMonth: 150,
  productionDomains: 1,
};
