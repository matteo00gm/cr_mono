import { describe, expect, it } from 'vitest';

import { widgetChatEvent, widgetConfigResponse, widgetProduct } from '../src/responses.js';

/**
 * What the widget surface promises the world (P2-10, P2-29, P3-08).
 *
 * **These three shapes are world-readable on somebody else's storefront.** They
 * are published as `openapi.json` and compiled into a bundle a seller pastes
 * into their shop — so what they refuse matters as much as what they accept.
 * `additionalProperties: false` is a promise to a widget author, and a schema
 * that quietly accepted an unknown key would be making a different one.
 *
 * Nothing re-validates outbound at runtime: the port is typed, so an extra
 * field is a type error in our own code, and *this* is what pins the published
 * contract.
 */

const CARD = {
  name: 'Barolo Bussia',
  producer: 'Cantina Rossi',
  vintage: 2016,
  priceCents: 4200,
  currency: 'EUR',
  imageUrl: null,
  productUrl: null,
  stockStatus: 'IN_STOCK',
} as const;

describe('the product a shopper is shown', () => {
  it('accepts the card the server sends', () => {
    expect(widgetProduct.safeParse(CARD).success).toBe(true);
  });

  it('refuses a field the contract does not name', () => {
    /*
     * `stockQty` is the live example: a seller's inventory level, on a public
     * endpoint, published to anyone who asks. It is not in the schema and a
     * lenient schema would have let it through and stripped it silently.
     */
    expect(widgetProduct.safeParse({ ...CARD, stockQty: 3 }).success).toBe(false);
  });

  it('names no seller-only field', () => {
    // The seller's own record has fifteen more. None of them belong here.
    expect(Object.keys(widgetProduct.shape).sort()).toEqual([
      'currency',
      'imageUrl',
      'name',
      'priceCents',
      'producer',
      'productUrl',
      'stockStatus',
      'vintage',
    ]);
  });

  it('allows the fields a catalogue is allowed to be missing', () => {
    expect(
      widgetProduct.safeParse({
        ...CARD,
        producer: null,
        vintage: null,
        imageUrl: null,
        productUrl: null,
      }).success,
    ).toBe(true);
  });

  it('refuses a stock status nobody defined', () => {
    expect(widgetProduct.safeParse({ ...CARD, stockStatus: 'MAYBE' }).success).toBe(false);
  });
});

describe('a recommendation carries its card', () => {
  const event = {
    type: 'recommendations',
    items: [{ productId: 'p1', reason: 'tannino deciso', confidence: 0.9, product: CARD }],
  };

  it('accepts a recommendation with its card attached', () => {
    expect(widgetChatEvent.safeParse(event).success).toBe(true);
  });

  it('refuses a recommendation with no card', () => {
    /*
     * The model supplies an id and a reason; the card is ours (§1.5, P2-25). A
     * contract that made it optional would make "every displayed field comes
     * from our own catalogue" a thing the client had to hope for.
     */
    expect(
      widgetChatEvent.safeParse({
        type: 'recommendations',
        items: [{ productId: 'p1', reason: 'tannino deciso', confidence: 0.9 }],
      }).success,
    ).toBe(false);
  });

  it('refuses an unknown field inside the card', () => {
    expect(
      widgetChatEvent.safeParse({
        ...event,
        items: [{ ...event.items[0], product: { ...CARD, stockQty: 3 } }],
      }).success,
    ).toBe(false);
  });

  it('refuses a confidence outside nought to one', () => {
    expect(
      widgetChatEvent.safeParse({
        ...event,
        items: [{ ...event.items[0], confidence: 1.5 }],
      }).success,
    ).toBe(false);
  });
});

describe('the config a storefront reads before anything else', () => {
  it('refuses a field the contract does not name', () => {
    // Edge-cached and world-readable: a tenant id or a plan added here reaches
    // every visitor of every seller (P2-10).
    expect(
      widgetConfigResponse.safeParse({
        status: 'ACTIVE',
        locale: 'it',
        theme: { primaryColor: '#7b1e3c', position: 'bottom-right', avatarUrl: null },
        welcomeMessage: 'Posso consigliarle un vino?',
        cartUrl: '/cart',
        quotaState: 'ok',
        plan: 'CANTINA',
      }).success,
    ).toBe(false);
  });
});
