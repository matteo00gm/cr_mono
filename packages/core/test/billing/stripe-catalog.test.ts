import { describe, expect, it } from 'vitest';

import {
  applyCatalog,
  CatalogConflictError,
  differencesFrom,
  planCatalog,
  productIdFor,
  type CatalogPrice,
  type StripeCatalog,
} from '../../src/billing/stripe-catalog.js';
import { PLANS } from '../../src/plans.js';

/**
 * Reconciling the Stripe catalogue with `plans.ts` (P5-01).
 *
 * Against an in-memory Stripe that behaves as the real one does in the ways
 * that matter here: `pricesByLookupKey` answers active prices only, and
 * creating a price moves the lookup key off whichever price held it. The
 * adapter that speaks HTTP is exercised by `scripts/test/stripe-setup.test.mjs`.
 */

interface Seed {
  readonly prices?: CatalogPrice[];
  readonly products?: string[];
}

const memoryStripe = ({ prices = [], products = [] }: Seed = {}) => {
  const held = prices.map((price) => ({ ...price }));
  const known = new Set(products);
  const writes: string[] = [];
  let next = 0;

  const catalog: StripeCatalog = {
    pricesByLookupKey: (keys) =>
      Promise.resolve(
        held.filter((price) => price.lookupKey !== null && keys.includes(price.lookupKey)),
      ),
    hasProduct: (id) => Promise.resolve(known.has(id)),
    createProduct: (product) => {
      writes.push(`product ${product.id} "${product.name}" plan=${product.metadata.plan}`);
      known.add(product.id);

      return Promise.resolve();
    },
    createPrice: (price) => {
      writes.push(
        `price ${price.lookupKey} ${String(price.unitAmount)} ${price.currency}/${price.interval} ` +
          `on ${price.productId} "${price.nickname}" plan=${price.metadata.plan}`,
      );

      /* The transfer: whoever held the key no longer does. */
      for (const other of held) {
        if (other.lookupKey === price.lookupKey) Object.assign(other, { lookupKey: null });
      }

      next += 1;

      const created: CatalogPrice = {
        id: `price_${String(next)}`,
        lookupKey: price.lookupKey,
        productId: price.productId,
        unitAmount: price.unitAmount,
        currency: price.currency,
        interval: price.interval,
      };

      held.push(created);

      return Promise.resolve(created);
    },
  };

  return { catalog, writes, held };
};

/** A live price exactly as `plans.ts` describes it. */
const agreeing = (plan: (typeof PLANS)[keyof typeof PLANS], id: string): CatalogPrice => ({
  id,
  lookupKey: plan.lookupKey,
  productId: productIdFor(plan),
  unitAmount: plan.amountCents,
  currency: plan.currency,
  interval: plan.interval,
});

describe('an account with nothing in it', () => {
  it('plans a product and a price for every plan, and writes nothing while planning', async () => {
    const stripe = memoryStripe();

    expect(await planCatalog(stripe.catalog)).toEqual([
      { kind: 'create', plan: 'CANTINA', productExists: false },
      { kind: 'create', plan: 'ECOMMERCE', productExists: false },
    ]);
    expect(stripe.writes).toEqual([]);
  });

  it('creates them from plans.ts and nowhere else', async () => {
    const stripe = memoryStripe();

    const results = await applyCatalog(stripe.catalog, await planCatalog(stripe.catalog));

    expect(stripe.writes).toEqual([
      'product plan_cantina "Cantina" plan=CANTINA',
      'price cantina_monthly_eur 2900 eur/month on plan_cantina "Cantina" plan=CANTINA',
      'product plan_ecommerce "E-commerce" plan=ECOMMERCE',
      'price ecommerce_monthly_eur 7900 eur/month on plan_ecommerce "E-commerce" plan=ECOMMERCE',
    ]);
    expect(results).toEqual([
      { plan: 'CANTINA', kind: 'create', priceId: 'price_1' },
      { plan: 'ECOMMERCE', kind: 'create', priceId: 'price_2' },
    ]);
  });
});

describe('running it twice', () => {
  it('creates nothing new the second time', async () => {
    const stripe = memoryStripe();

    await applyCatalog(stripe.catalog, await planCatalog(stripe.catalog));
    const first = [...stripe.writes];

    const again = await applyCatalog(stripe.catalog, await planCatalog(stripe.catalog));

    expect(stripe.writes).toEqual(first);
    expect(again).toEqual([
      { plan: 'CANTINA', kind: 'unchanged', priceId: 'price_1' },
      { plan: 'ECOMMERCE', kind: 'unchanged', priceId: 'price_2' },
    ]);
  });

  it('finishes a run that stopped between the product and its price', async () => {
    const stripe = memoryStripe({
      prices: [agreeing(PLANS.CANTINA, 'price_live')],
      products: ['plan_cantina', 'plan_ecommerce'],
    });

    await applyCatalog(stripe.catalog, await planCatalog(stripe.catalog));

    expect(stripe.writes).toEqual([
      'price ecommerce_monthly_eur 7900 eur/month on plan_ecommerce "E-commerce" plan=ECOMMERCE',
    ]);
  });
});

describe('a price that disagrees with its plan', () => {
  const cheaper = { ...agreeing(PLANS.CANTINA, 'price_old'), unitAmount: 2_500 };

  it('is reported with the fields that differ', async () => {
    const stripe = memoryStripe({ prices: [cheaper] });

    expect((await planCatalog(stripe.catalog))[0]).toEqual({
      kind: 'differs',
      plan: 'CANTINA',
      previous: cheaper,
      fields: ['amount'],
    });
  });

  it('stops the whole run, including the plan that only needed creating', async () => {
    /*
     * Half a catalogue is harder to reason about than none. E-commerce is
     * missing and would be created on its own; with Cantina in dispute it is
     * not, so the operator fixes one thing and reruns rather than untangling
     * what a partial run did.
     */
    const stripe = memoryStripe({ prices: [cheaper] });
    const steps = await planCatalog(stripe.catalog);

    await expect(applyCatalog(stripe.catalog, steps)).rejects.toThrow(CatalogConflictError);
    expect(stripe.writes).toEqual([]);
  });

  it('says which plan, which fields, and how to go on', async () => {
    const stripe = memoryStripe({
      prices: [cheaper, { ...agreeing(PLANS.ECOMMERCE, 'price_e'), currency: 'usd' }],
    });

    await expect(applyCatalog(stripe.catalog, await planCatalog(stripe.catalog))).rejects.toThrow(
      'Stripe disagrees with plans.ts, so nothing was changed: CANTINA (amount); ' +
        'ECOMMERCE (currency). Run again with --reprice to replace those prices for new subscribers.',
    );
  });

  it('is replaced under --reprice, the key moving and the old price left for its subscribers', async () => {
    const stripe = memoryStripe({
      prices: [cheaper, agreeing(PLANS.ECOMMERCE, 'price_e')],
      products: ['plan_cantina', 'plan_ecommerce'],
    });
    const steps = await planCatalog(stripe.catalog, { reprice: true });

    expect(steps[0]).toEqual({
      kind: 'reprice',
      plan: 'CANTINA',
      productExists: true,
      previous: cheaper,
      fields: ['amount'],
    });

    const results = await applyCatalog(stripe.catalog, steps);

    expect(results).toEqual([
      { plan: 'CANTINA', kind: 'reprice', priceId: 'price_1' },
      { plan: 'ECOMMERCE', kind: 'unchanged', priceId: 'price_e' },
    ]);
    expect(stripe.writes).toEqual([
      'price cantina_monthly_eur 2900 eur/month on plan_cantina "Cantina" plan=CANTINA',
    ]);
    /* Still there, no longer holding the key: existing subscribers keep paying it. */
    expect(stripe.held.find((price) => price.id === 'price_old')?.lookupKey).toBeNull();
  });

  it('creates the product too when a reprice finds it missing', async () => {
    const stripe = memoryStripe({ prices: [{ ...cheaper, productId: 'prod_clicked' }] });

    await applyCatalog(stripe.catalog, await planCatalog(stripe.catalog, { reprice: true }));

    expect(stripe.writes.slice(0, 2)).toEqual([
      'product plan_cantina "Cantina" plan=CANTINA',
      'price cantina_monthly_eur 2900 eur/month on plan_cantina "Cantina" plan=CANTINA',
    ]);
  });
});

describe('what counts as disagreeing', () => {
  const plan = PLANS.ECOMMERCE;
  const live = agreeing(plan, 'price_e');

  it('is nothing, for a price exactly as the plan describes it', () => {
    expect(differencesFrom(plan, live)).toEqual([]);
  });

  it.each([
    ['product', { productId: 'prod_clicked_in_the_dashboard' }],
    ['amount', { unitAmount: 7_800 }],
    ['currency', { currency: 'usd' }],
    ['interval', { interval: 'year' }],
    ['interval', { interval: null }],
  ] as const)('is the %s', (field, change) => {
    expect(differencesFrom(plan, { ...live, ...change })).toEqual([field]);
  });

  it('lists every field that differs, not only the first', () => {
    expect(differencesFrom(plan, { ...live, unitAmount: 1, currency: 'usd' })).toEqual([
      'amount',
      'currency',
    ]);
  });
});

describe('product ids', () => {
  it('are ours and stable, so a product is found rather than searched for', () => {
    expect(productIdFor(PLANS.CANTINA)).toBe('plan_cantina');
    expect(productIdFor(PLANS.ECOMMERCE)).toBe('plan_ecommerce');
  });
});
