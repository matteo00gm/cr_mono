import { PLAN_IDS, PLANS, type Plan, type PlanId } from '../plans.js';

/**
 * The Stripe catalogue, reconciled against `plans.ts` (P5-01).
 *
 * **Planned first, applied second, and applied whole or not at all.** An
 * operator sees every step before anything is written, and a run that finds a
 * plan disagreeing with Stripe changes nothing — not the plans that agreed
 * either — because half a catalogue is harder to reason about than none.
 *
 * **Idempotent on the lookup key.** A second run finds every price under its
 * key and creates nothing. Products carry ids of our choosing (`plan_cantina`),
 * so they are found the same way rather than by searching names.
 *
 * Behind a port because `core` imports no vendor SDK and no HTTP; the adapter
 * is `scripts/stripe-setup.mjs`, and the tests drive this with an in-memory
 * Stripe.
 */

/**
 * Pinned, so a Dashboard upgrade cannot change a response under us.
 *
 * Stripe answers an unversioned request in the account's default version,
 * which is a setting somebody can change with a click. Checked against
 * Stripe's upgrade guide on 2026-09-30.
 */
export const STRIPE_API_VERSION = '2026-08-26.dahlia';

export interface CatalogPrice {
  readonly id: string;
  readonly lookupKey: string | null;
  readonly productId: string;
  readonly unitAmount: number | null;
  readonly currency: string;
  /** `null` for a one-time price. */
  readonly interval: string | null;
}

export interface NewProduct {
  readonly id: string;
  readonly name: string;
  readonly metadata: { readonly plan: PlanId };
}

export interface NewPrice {
  readonly productId: string;
  readonly lookupKey: string;
  readonly nickname: string;
  readonly unitAmount: number;
  readonly currency: string;
  readonly interval: string;
  readonly metadata: { readonly plan: PlanId };
}

export interface StripeCatalog {
  /** The *active* prices carrying any of these lookup keys. */
  readonly pricesByLookupKey: (keys: readonly string[]) => Promise<readonly CatalogPrice[]>;
  /** Whether a product with this id exists, archived or not. */
  readonly hasProduct: (id: string) => Promise<boolean>;
  readonly createProduct: (product: NewProduct) => Promise<void>;
  /**
   * Creates a price and moves the lookup key onto it.
   *
   * **Always a transfer**, because a key can be held by an archived price, and
   * creating a price with a key somebody else holds is an error rather than a
   * move. For a key nobody holds, a transfer is simply a create.
   */
  readonly createPrice: (price: NewPrice) => Promise<CatalogPrice>;
}

export type CatalogStep =
  | { readonly kind: 'unchanged'; readonly plan: PlanId; readonly priceId: string }
  | { readonly kind: 'create'; readonly plan: PlanId; readonly productExists: boolean }
  | {
      readonly kind: 'reprice';
      readonly plan: PlanId;
      readonly productExists: boolean;
      readonly previous: CatalogPrice;
      readonly fields: readonly string[];
    }
  | {
      readonly kind: 'differs';
      readonly plan: PlanId;
      readonly previous: CatalogPrice;
      readonly fields: readonly string[];
    };

type Conflict = Extract<CatalogStep, { readonly kind: 'differs' }>;
type Actionable = Exclude<CatalogStep, Conflict>;

export interface CatalogResult {
  readonly plan: PlanId;
  readonly kind: 'unchanged' | 'create' | 'reprice';
  readonly priceId: string;
}

/** Ours, and stable across environments, so a product is found rather than searched for. */
export const productIdFor = (plan: Plan): string => `plan_${plan.id.toLowerCase()}`;

/** What about a live price disagrees with the plan it is filed under. */
export const differencesFrom = (plan: Plan, price: CatalogPrice): string[] => {
  const fields: string[] = [];

  if (price.productId !== productIdFor(plan)) fields.push('product');
  if (price.unitAmount !== plan.amountCents) fields.push('amount');
  if (price.currency !== plan.currency) fields.push('currency');
  if (price.interval !== plan.interval) fields.push('interval');

  return fields;
};

export interface PlanCatalogOptions {
  /**
   * Replace a price that disagrees with its plan.
   *
   * **Off unless asked**, because it is a pricing decision rather than a repair:
   * the new price is what every *new* subscriber pays, and the old one stays
   * active for the subscribers it already has. Without it, a disagreement stops
   * the run and says which fields differ.
   */
  readonly reprice?: boolean | undefined;
}

/** Reads Stripe and says what applying would do. Writes nothing. */
export const planCatalog = async (
  catalog: StripeCatalog,
  { reprice = false }: PlanCatalogOptions = {},
): Promise<CatalogStep[]> => {
  const plans = PLAN_IDS.map((id) => PLANS[id]);
  const live = await catalog.pricesByLookupKey(plans.map((plan) => plan.lookupKey));
  const steps: CatalogStep[] = [];

  /* One at a time: an operator's script, where a readable request log beats speed. */
  for (const plan of plans) {
    const price = live.find((candidate) => candidate.lookupKey === plan.lookupKey);

    if (price === undefined) {
      steps.push({
        kind: 'create',
        plan: plan.id,
        productExists: await catalog.hasProduct(productIdFor(plan)),
      });
      continue;
    }

    const fields = differencesFrom(plan, price);

    if (fields.length === 0) {
      steps.push({ kind: 'unchanged', plan: plan.id, priceId: price.id });
    } else if (reprice) {
      steps.push({
        kind: 'reprice',
        plan: plan.id,
        productExists: await catalog.hasProduct(productIdFor(plan)),
        previous: price,
        fields,
      });
    } else {
      steps.push({ kind: 'differs', plan: plan.id, previous: price, fields });
    }
  }

  return steps;
};

export class CatalogConflictError extends Error {
  constructor(readonly conflicts: readonly Conflict[]) {
    super(
      'Stripe disagrees with plans.ts, so nothing was changed: ' +
        conflicts.map((step) => `${step.plan} (${step.fields.join(', ')})`).join('; ') +
        '. Run again with --reprice to replace those prices for new subscribers.',
    );
    this.name = 'CatalogConflictError';
  }
}

/** Carries out a plan from `planCatalog`, or refuses the whole of it. */
export const applyCatalog = async (
  catalog: StripeCatalog,
  steps: readonly CatalogStep[],
): Promise<CatalogResult[]> => {
  const conflicts = steps.filter((step): step is Conflict => step.kind === 'differs');

  if (conflicts.length > 0) throw new CatalogConflictError(conflicts);

  const results: CatalogResult[] = [];

  for (const step of steps as readonly Actionable[]) {
    if (step.kind === 'unchanged') {
      results.push({ plan: step.plan, kind: step.kind, priceId: step.priceId });
      continue;
    }

    const plan = PLANS[step.plan];
    const productId = productIdFor(plan);

    if (!step.productExists) {
      await catalog.createProduct({ id: productId, name: plan.name, metadata: { plan: plan.id } });
    }

    const created = await catalog.createPrice({
      productId,
      lookupKey: plan.lookupKey,
      nickname: plan.name,
      unitAmount: plan.amountCents,
      currency: plan.currency,
      interval: plan.interval,
      metadata: { plan: plan.id },
    });

    results.push({ plan: step.plan, kind: step.kind, priceId: created.id });
  }

  return results;
};
