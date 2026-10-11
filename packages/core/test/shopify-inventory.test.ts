import { describe, expect, it } from 'vitest';

import {
  readProductStock,
  STOCK_SYNC_PER_MINUTE,
  STOCK_SYNC_WINDOW_SEC,
  stockSyncLimitKey,
} from '../src/shopify/inventory.js';

/**
 * Reading a Shopify product for what is in stock (P6-11, §4.4).
 *
 * The two mistakes this row exists to avoid are both silent: a wine sold out
 * three days ago still being recommended, and a seller's whole catalogue
 * vanishing because Shopify does not count their bottles. Neither raises an
 * error anywhere, so each has a test that says its name.
 */

type Variant = Readonly<Record<string, unknown>>;

const variant = (overrides: Variant = {}): Variant => ({
  id: 45123456789,
  title: 'Default Title',
  price: '42.00',
  inventory_quantity: 6,
  inventory_management: 'shopify',
  inventory_policy: 'deny',
  ...overrides,
});

const product = (variants: readonly Variant[] = [variant()], overrides: Variant = {}): string =>
  JSON.stringify({
    id: 7890123456789,
    title: 'Barolo Bussia 2016',
    vendor: 'Cantina Rossi',
    updated_at: '2026-10-05T10:15:30+02:00',
    variants,
    ...overrides,
  });

const stockOf = (overrides: Variant) =>
  readProductStock(product([variant(overrides)]))?.variants[0];

describe('a variant Shopify counts', () => {
  it('is in stock with the bottles the shop has', () => {
    expect(readProductStock(product())).toEqual({
      updatedAt: new Date('2026-10-05T08:15:30.000Z'),
      variants: [{ variantId: '45123456789', status: 'IN_STOCK', quantity: 6 }],
    });
  });

  it('is sold out when every location has none left', () => {
    expect(stockOf({ inventory_quantity: 0 })).toEqual({
      variantId: '45123456789',
      status: 'OUT_OF_STOCK',
      quantity: 0,
    });
  });

  it('stays in stock when one location is empty and another is not', () => {
    /*
     * The multi-location trap. `inventory_quantity` is Shopify's own sum over
     * every location, so a warehouse at zero beside a shop with three bottles
     * arrives as three — which is the one number that answers "can it be
     * bought". Nothing is summed here because nothing arrives in parts.
     */
    expect(stockOf({ inventory_quantity: 0 + 3 })).toMatchObject({
      status: 'IN_STOCK',
      quantity: 3,
    });
  });

  it('is sold out, at none, when the shop has oversold it', () => {
    expect(stockOf({ inventory_quantity: -2 })).toEqual({
      variantId: '45123456789',
      status: 'OUT_OF_STOCK',
      quantity: 0,
    });
  });

  it('can still be ordered when the shop keeps selling it at none', () => {
    /* "Continue selling when out of stock": the shopper can buy it, and the widget says how. */
    expect(stockOf({ inventory_quantity: 0, inventory_policy: 'continue' })).toMatchObject({
      status: 'PREORDER',
      quantity: 0,
    });
    expect(stockOf({ inventory_quantity: -4, inventory_policy: 'continue' })).toMatchObject({
      status: 'PREORDER',
      quantity: 0,
    });
  });

  it('is simply in stock while there are bottles, whatever the policy', () => {
    expect(stockOf({ inventory_quantity: 2, inventory_policy: 'continue' })).toMatchObject({
      status: 'IN_STOCK',
      quantity: 2,
    });
  });
});

describe('a variant Shopify does not count', () => {
  it('is in stock, not zero', () => {
    /*
     * An untracked wine reports a quantity of zero. Read as sold out, a
     * seller's entire catalogue would disappear the moment they connected
     * their store — with no error anywhere.
     */
    expect(stockOf({ inventory_management: null, inventory_quantity: 0 })).toEqual({
      variantId: '45123456789',
      status: 'IN_STOCK',
      quantity: null,
    });
  });

  it('is in stock whatever number came with it', () => {
    expect(stockOf({ inventory_management: null, inventory_quantity: -3 })).toMatchObject({
      status: 'IN_STOCK',
      quantity: null,
    });
  });
});

describe('a variant that says too little', () => {
  /** A variant whose body never mentions one field: absent, which is not the same as `null`. */
  const without = (field: string): Variant =>
    Object.fromEntries(Object.entries(variant()).filter(([name]) => name !== field));

  it('keeps the stock it had when tracking is not mentioned at all', () => {
    /* Absent is not `null`: a body that does not say has not said "untracked". */
    expect(readProductStock(product([without('inventory_management')]))?.variants).toEqual([]);
  });

  it('keeps the stock it had when it is counted and no count came', () => {
    expect(readProductStock(product([without('inventory_quantity')]))?.variants).toEqual([]);
  });

  it.each([
    ['no id', { id: undefined }],
    ['an id that is not a number', { id: 'gid://shopify/ProductVariant/1' }],
    ['an id past what JSON carries whole', { id: 2 ** 53 + 2 }],
    ['a count that is not a whole number', { inventory_quantity: 1.5 }],
  ])('is left out with %s, and the others are still read', (_, broken) => {
    const read = readProductStock(product([variant(broken), variant({ id: 222 })]));

    expect(read?.variants.map(({ variantId }) => variantId)).toEqual(['222']);
  });
});

describe('a product', () => {
  it('reports each of its variants', () => {
    const read = readProductStock(
      product([
        variant({ id: 1, inventory_quantity: 4 }),
        variant({ id: 2, inventory_quantity: 0 }),
        variant({ id: 3, inventory_management: null }),
      ]),
    );

    expect(read?.variants).toEqual([
      { variantId: '1', status: 'IN_STOCK', quantity: 4 },
      { variantId: '2', status: 'OUT_OF_STOCK', quantity: 0 },
      { variantId: '3', status: 'IN_STOCK', quantity: null },
    ]);
  });

  it('with no variants has nothing to say', () => {
    expect(readProductStock(product([]))?.variants).toEqual([]);
  });

  it('says when it changed, which is what orders one report against another', () => {
    expect(readProductStock(product())?.updatedAt?.toISOString()).toBe('2026-10-05T08:15:30.000Z');
  });

  it('with no date it can read leaves the moment to the caller', () => {
    expect(readProductStock(product([variant()], { updated_at: undefined }))?.updatedAt).toBe(
      undefined,
    );
    expect(readProductStock(product([variant()], { updated_at: 'ieri' }))?.updatedAt).toBe(
      undefined,
    );
  });

  it.each([
    ['not JSON', '{"id": 1, '],
    ['not an object', '"a product"'],
    ['without variants', JSON.stringify({ id: 1, updated_at: '2026-10-05T10:15:30+02:00' })],
    ['with variants that are not a list', JSON.stringify({ variants: 'none' })],
  ])('that is %s is not read', (_, body) => {
    expect(readProductStock(body)).toBeUndefined();
  });

  it('gives back stock and nothing else of the product', () => {
    const read = JSON.stringify(readProductStock(product()));

    expect(read).not.toContain('Barolo');
    expect(read).not.toContain('42.00');
    expect(Object.keys(readProductStock(product())?.variants[0] ?? {}).sort()).toEqual([
      'quantity',
      'status',
      'variantId',
    ]);
  });
});

describe('the allowance', () => {
  it('counts each shop on its own', () => {
    expect(stockSyncLimitKey('cantina-rossi.myshopify.com')).toBe(
      'shopify:stock:cantina-rossi.myshopify.com',
    );
    expect(stockSyncLimitKey('a.myshopify.com')).not.toBe(stockSyncLimitKey('b.myshopify.com'));
  });

  it('is ten a second, by the minute', () => {
    expect(STOCK_SYNC_PER_MINUTE / STOCK_SYNC_WINDOW_SEC).toBe(10);
  });
});
