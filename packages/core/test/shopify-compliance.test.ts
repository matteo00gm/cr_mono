import { describe, expect, it } from 'vitest';

import { readCustomerRequest, readShopRedact } from '../src/shopify/compliance.js';

/**
 * Shopify's privacy requests (P6-09b): what is read from one, and what is not.
 *
 * The bodies name a customer — an id, an email, a phone number — and the whole
 * of this file's job is that none of it comes out the other side.
 */

const SHOP = 'cantina-rossi.myshopify.com';

type Body = Readonly<Record<string, unknown>>;

const redact = (overrides: Body = {}): string =>
  JSON.stringify({
    shop_id: 954889,
    shop_domain: SHOP,
    customer: { id: 191167, email: 'giulia.bianchi@example.com', phone: '+39 333 0000000' },
    orders_to_redact: [5678901234567, 5678901234568],
    ...overrides,
  });

const dataRequest = (overrides: Body = {}): string =>
  JSON.stringify({
    shop_id: 954889,
    shop_domain: SHOP,
    orders_requested: [5678901234567],
    customer: { id: 191167, email: 'giulia.bianchi@example.com', phone: '+39 333 0000000' },
    data_request: { id: 9999 },
    ...overrides,
  });

describe('a customer’s erasure', () => {
  it('names the shop from the signed body, and each order in both spellings', () => {
    /* A sale is keyed by the GraphQL id when its order had one, the number when not (P6-08). */
    expect(readCustomerRequest(redact())).toEqual({
      shop: SHOP,
      orderIds: [
        'gid://shopify/Order/5678901234567',
        '5678901234567',
        'gid://shopify/Order/5678901234568',
        '5678901234568',
      ],
      requestId: undefined,
    });
  });

  it('names no orders for a customer who never placed one', () => {
    expect(readCustomerRequest(redact({ orders_to_redact: [] }))?.orderIds).toEqual([]);
    expect(readCustomerRequest(redact({ orders_to_redact: undefined }))?.orderIds).toEqual([]);
  });

  it('leaves out an order it cannot name exactly, and keeps the rest', () => {
    const read = readCustomerRequest(
      redact({ orders_to_redact: ['5678901234567', null, 2 ** 53 + 2, -1, 1.5, 42] }),
    );

    expect(read?.orderIds).toEqual(['gid://shopify/Order/42', '42']);
  });
});

describe('a customer’s data request', () => {
  it('names the orders asked after, and the id Shopify gave the request', () => {
    expect(readCustomerRequest(dataRequest())).toEqual({
      shop: SHOP,
      orderIds: ['gid://shopify/Order/5678901234567', '5678901234567'],
      requestId: '9999',
    });
  });

  it('has no id to answer by when Shopify gave none it can read', () => {
    expect(readCustomerRequest(dataRequest({ data_request: undefined }))?.requestId).toBe(
      undefined,
    );
    expect(readCustomerRequest(dataRequest({ data_request: { id: 'nine' } }))?.requestId).toBe(
      undefined,
    );
  });
});

describe('whose request it is', () => {
  it.each([
    ['no shop', { shop_domain: undefined }],
    ['a shop that is not a shop', { shop_domain: 'evil.example' }],
    [
      'a shop under somebody else’s zone',
      { shop_domain: 'cantina-rossi.myshopify.com.evil.example' },
    ],
    ['a shop that is not a name', { shop_domain: 954889 }],
  ])('is not read with %s', (_, overrides) => {
    expect(readCustomerRequest(redact(overrides))).toBeUndefined();
    expect(readShopRedact(JSON.stringify({ shop_id: 954889, ...overrides }))).toBeUndefined();
  });

  it.each(['{"shop_domain": ', '"a request"', 'null', '[]'])('is not read from %s', (body) => {
    expect(readCustomerRequest(body)).toBeUndefined();
    expect(readShopRedact(body)).toBeUndefined();
  });

  it('is the shop the body names, for a shop’s own erasure', () => {
    expect(readShopRedact(JSON.stringify({ shop_id: 954889, shop_domain: SHOP }))).toBe(SHOP);
  });
});

describe('the customer', () => {
  it('is not in what comes back, whatever the body said of them', () => {
    for (const read of [readCustomerRequest(redact()), readCustomerRequest(dataRequest())]) {
      const out = JSON.stringify(read);

      for (const personal of ['giulia', 'example.com', '333', '191167']) {
        expect(out).not.toContain(personal);
      }

      expect(Object.keys(read ?? {}).sort()).toEqual(['orderIds', 'requestId', 'shop']);
    }
  });
});
