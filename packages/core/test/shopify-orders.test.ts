import { describe, expect, it } from 'vitest';

import { ATTRIBUTION_PROPERTY, hundredths, readOrder } from '../src/shopify/orders.js';

/**
 * Reading a Shopify order for what the sommelier sold (P6-07).
 *
 * The rules a seller's trust in the number rests on: only the lines the widget
 * added, at what was actually paid for them, and nothing about who paid.
 */

const VISIT = '4f6c1d0a-9b7e-4c55-8e21-0d1f2a3b4c5d';
const OTHER_VISIT = 'a1b2c3d4-0000-4000-8000-aabbccddeeff';

type Line = Readonly<Record<string, unknown>>;

const line = (overrides: Line = {}): Line => ({
  id: 14234727219537,
  admin_graphql_api_id: 'gid://shopify/LineItem/14234727219537',
  variant_id: 45123456789,
  quantity: 1,
  price: '42.00',
  discount_allocations: [],
  properties: [{ name: ATTRIBUTION_PROPERTY, value: VISIT }],
  ...overrides,
});

/** An order as Shopify sends one, buyer included — which is the point of several tests below. */
const order = (lines: readonly Line[] = [line()], overrides: Line = {}): string =>
  JSON.stringify({
    id: 5678901234567,
    admin_graphql_api_id: 'gid://shopify/Order/5678901234567',
    currency: 'EUR',
    created_at: '2026-10-05T10:15:30+02:00',
    email: 'giulia.bianchi@example.com',
    phone: '+39 333 0000000',
    customer: { first_name: 'Giulia', last_name: 'Bianchi', email: 'giulia.bianchi@example.com' },
    shipping_address: { address1: 'Via Roma 1', city: 'Alba', zip: '12051' },
    note: 'Suonare al citofono Bianchi',
    line_items: lines,
    ...overrides,
  });

describe('an amount', () => {
  it.each([
    ['42.00', 4200],
    ['42', 4200],
    ['42.5', 4250],
    ['0.07', 7],
    ['1234567.89', 123456789],
    /* A third decimal rounds half up, never through a float. */
    ['0.005', 1],
    ['0.004', 0],
    ['19.995', 2000],
    ['0.1', 10],
    [' 42.00 ', 4200],
  ])('reads %s as %d hundredths', (written, cents) => {
    expect(hundredths(written)).toBe(cents);
  });

  it.each(['', '-1.00', '1e3', '42,00', '.5', 'forty-two', '1.2.3', '9'.repeat(13)])(
    'does not read %s as an amount at all',
    (written) => {
      expect(hundredths(written)).toBeUndefined();
    },
  );

  it('adds up without a float anywhere', () => {
    /* 0.1 + 0.2 is 0.30000000000000004 in a float, and 30 here. */
    expect((hundredths('0.1') ?? 0) + (hundredths('0.2') ?? 0)).toBe(30);
  });
});

describe('the lines that are ours', () => {
  it('is a line the widget planted its visit on, at what was paid for it', () => {
    expect(readOrder(order())).toEqual({
      orderId: 'gid://shopify/Order/5678901234567',
      currency: 'EUR',
      orderedAt: new Date('2026-10-05T08:15:30.000Z'),
      lines: [
        {
          lineItemId: 'gid://shopify/LineItem/14234727219537',
          sessionId: VISIT,
          variantId: '45123456789',
          quantity: 1,
          amountCents: 4200,
        },
      ],
    });
  });

  it('is only that line: the wines a shopper found themselves are not counted', () => {
    const read = readOrder(
      order([
        line({ admin_graphql_api_id: 'gid://shopify/LineItem/1', properties: [] }),
        line({ admin_graphql_api_id: 'gid://shopify/LineItem/2' }),
        line({ admin_graphql_api_id: 'gid://shopify/LineItem/3', properties: undefined }),
        line({
          admin_graphql_api_id: 'gid://shopify/LineItem/4',
          properties: [{ name: 'Incisione', value: VISIT }],
        }),
      ]),
    );

    expect(read?.lines.map(({ lineItemId }) => lineItemId)).toEqual(['gid://shopify/LineItem/2']);
  });

  it('is nothing at all for an order the sommelier had no part in', () => {
    expect(readOrder(order([line({ properties: [] })]))?.lines).toEqual([]);
  });

  it('keeps two visits in one order apart', () => {
    const read = readOrder(
      order([
        line({ admin_graphql_api_id: 'gid://shopify/LineItem/1' }),
        line({
          admin_graphql_api_id: 'gid://shopify/LineItem/2',
          properties: [{ name: ATTRIBUTION_PROPERTY, value: OTHER_VISIT }],
        }),
      ]),
    );

    expect(read?.lines.map(({ sessionId }) => sessionId)).toEqual([VISIT, OTHER_VISIT]);
  });

  it.each([
    ['a number', 42],
    ['nothing', null],
    ['too short to be a visit', 'abc'],
    ['markup', '<script>alert(1)</script>'],
    ['a visit with something appended', `${VISIT}'; drop table attributions`],
    ['longer than a visit is', 'a'.repeat(65)],
  ])(
    'does not take %s for a visit: the property is typed by whoever fills the cart',
    (_, value) => {
      expect(
        readOrder(order([line({ properties: [{ name: ATTRIBUTION_PROPERTY, value }] })]))?.lines,
      ).toEqual([]);
    },
  );
});

describe('what a line was sold for', () => {
  it('is the price times the quantity', () => {
    expect(readOrder(order([line({ price: '18.50', quantity: 6 })]))?.lines[0]).toMatchObject({
      quantity: 6,
      amountCents: 11100,
    });
  });

  it('is less every discount the order gave that line', () => {
    const read = readOrder(
      order([
        line({
          price: '42.00',
          quantity: 2,
          discount_allocations: [
            { amount: '8.40' },
            { amount: '1.60', discount_application_index: 1 },
          ],
        }),
      ]),
    );

    expect(read?.lines[0]?.amountCents).toBe(7400);
  });

  it('is never less than nothing', () => {
    const read = readOrder(
      order([line({ price: '10.00', discount_allocations: [{ amount: '12.00' }] })]),
    );

    expect(read?.lines[0]?.amountCents).toBe(0);
  });

  it('is not guessed: a line whose price or discount cannot be read is left out', () => {
    const read = readOrder(
      order([
        line({ admin_graphql_api_id: 'gid://shopify/LineItem/1', price: 'quarantadue' }),
        line({
          admin_graphql_api_id: 'gid://shopify/LineItem/2',
          discount_allocations: [{ amount: 'half' }],
        }),
        line({ admin_graphql_api_id: 'gid://shopify/LineItem/3' }),
      ]),
    );

    expect(read?.lines.map(({ lineItemId }) => lineItemId)).toEqual(['gid://shopify/LineItem/3']);
  });

  it.each([0, -1, 1.5, 100_001])('leaves out a line with a quantity of %d', (quantity) => {
    expect(readOrder(order([line({ quantity })]))?.lines).toEqual([]);
  });
});

describe('ids', () => {
  it('falls back to the number when there is no GraphQL id, while the number is exact', () => {
    const read = readOrder(
      order([line({ admin_graphql_api_id: undefined })], { admin_graphql_api_id: undefined }),
    );

    expect(read?.orderId).toBe('5678901234567');
    expect(read?.lines[0]?.lineItemId).toBe('14234727219537');
  });

  it('does not believe a number too large for JSON to have carried whole', () => {
    /* 820982911946154508 is the id in Shopify's own test notification. */
    const body = order([line()], { admin_graphql_api_id: undefined }).replace(
      '"id":5678901234567',
      '"id":820982911946154508',
    );

    expect(readOrder(body)).toBeUndefined();
  });

  it('leaves out a line it cannot name, and keeps the order', () => {
    const read = readOrder(
      order([line({ admin_graphql_api_id: undefined, id: undefined }), line()]),
    );

    expect(read?.lines).toHaveLength(1);
  });

  it('records a line with no variant as a sale of no wine in particular', () => {
    expect(readOrder(order([line({ variant_id: null })]))?.lines[0]?.variantId).toBeNull();
    expect(readOrder(order([line({ variant_id: 'sku-1' })]))?.lines[0]?.variantId).toBeNull();
  });
});

describe('an order', () => {
  it('that is a test is nobody’s revenue', () => {
    expect(readOrder(order([line()], { test: true }))?.lines).toEqual([]);
    expect(readOrder(order([line()], { test: false }))?.lines).toHaveLength(1);
  });

  it('with no date it can read is left for the caller to stamp', () => {
    expect(readOrder(order([line()], { created_at: undefined }))?.orderedAt).toBeUndefined();
    expect(readOrder(order([line()], { created_at: 'ieri' }))?.orderedAt).toBeUndefined();
  });

  it.each([
    ['not JSON', '{"id": 1, '],
    ['not an object', '"an order"'],
    ['without line items', JSON.stringify({ id: 1, currency: 'EUR' })],
    ['without a currency', JSON.stringify({ id: 1, line_items: [] })],
    ['in a currency that is not a code', order([line()], { currency: 'euro' })],
    ['without an id', order([line()], { id: undefined, admin_graphql_api_id: undefined })],
  ])('that is %s is not read', (_, body) => {
    expect(readOrder(body)).toBeUndefined();
  });

  it('gives back nothing about the buyer, whatever the body carried', () => {
    const read = JSON.stringify(readOrder(order()));

    for (const personal of ['giulia', 'Bianchi', 'Via Roma', '12051', '333', 'citofono']) {
      expect(read).not.toContain(personal);
    }

    expect(Object.keys(readOrder(order()) ?? {}).sort()).toEqual([
      'currency',
      'lines',
      'orderId',
      'orderedAt',
    ]);
  });
});
