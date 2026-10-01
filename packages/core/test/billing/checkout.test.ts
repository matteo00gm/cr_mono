import { describe, expect, it } from 'vitest';

import {
  BILLING_PATH,
  checkoutSessionParams,
  STRIPE_PLAN_KEY,
  STRIPE_TENANT_KEY,
  topUpSessionParams,
  type CheckoutRequest,
} from '../../src/billing/checkout.js';
import { tenantOfStripeEvent } from '../../src/billing/stripe-events.js';
import { encodeStripeForm } from '../../src/billing/stripe-form.js';

/**
 * The Checkout session a winery is sent to (P5-02).
 *
 * Asserted as the form Stripe receives, not only as an object: the tenant has
 * to arrive in the three places a webhook reads it back from, spelled the way
 * Stripe files them, or every later event about the subscription arrives with
 * no winery attached.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const request = (overrides: Partial<CheckoutRequest> = {}): CheckoutRequest => ({
  tenantId: TENANT,
  plan: 'CANTINA',
  priceId: 'price_cantina',
  customerId: null,
  locale: 'it',
  dashboardOrigin: 'https://app.catalogorosso.com',
  ...overrides,
});

const form = (overrides: Partial<CheckoutRequest> = {}) =>
  Object.fromEntries(encodeStripeForm(checkoutSessionParams(request(overrides))));

describe('the Checkout session', () => {
  it('sells one of the plan’s price, as a subscription', () => {
    expect(form()).toMatchObject({
      mode: 'subscription',
      'line_items[0][price]': 'price_cantina',
      'line_items[0][quantity]': '1',
    });
  });

  it('carries the tenant where the webhook reads it back: the session and the subscription', () => {
    expect(form({ plan: 'ECOMMERCE' })).toMatchObject({
      client_reference_id: TENANT,
      [`metadata[${STRIPE_TENANT_KEY}]`]: TENANT,
      [`metadata[${STRIPE_PLAN_KEY}]`]: 'ECOMMERCE',
      [`subscription_data[metadata][${STRIPE_TENANT_KEY}]`]: TENANT,
      [`subscription_data[metadata][${STRIPE_PLAN_KEY}]`]: 'ECOMMERCE',
    });
  });

  it('names the keys the webhook will look for', () => {
    expect([STRIPE_TENANT_KEY, STRIPE_PLAN_KEY]).toEqual(['tenant_id', 'plan']);
  });

  it('reuses the winery’s customer when it has one, so Stripe has one of them', () => {
    expect(form({ customerId: 'cus_returning' })).toMatchObject({ customer: 'cus_returning' });
  });

  it('names no customer for a first purchase, and Stripe makes one', () => {
    expect(form()).not.toHaveProperty('customer');
  });

  it('sends the owner back to the Fatturazione screen, finished or not', () => {
    expect(BILLING_PATH).toBe('/fatturazione');
    expect(form()).toMatchObject({
      success_url: 'https://app.catalogorosso.com/fatturazione?checkout=success',
      cancel_url: 'https://app.catalogorosso.com/fatturazione?checkout=cancelled',
    });
  });

  it.each([
    ['it', 'it'],
    ['en', 'en'],
    ['de', 'auto'],
  ])('shows Checkout in %s as %s', (locale, expected) => {
    expect(form({ locale })).toMatchObject({ locale: expected });
  });
});

describe('a top-up’s Checkout session (P5-11a)', () => {
  const topUp = (locale = 'it') =>
    Object.fromEntries(
      encodeStripeForm(
        topUpSessionParams({
          tenantId: TENANT,
          priceId: 'price_top_up',
          customerId: 'cus_1',
          locale,
          dashboardOrigin: 'https://app.catalogorosso.com',
        }),
      ),
    );

  it('sells one top-up, once, to the customer the winery already is', () => {
    expect(topUp()).toEqual({
      mode: 'payment',
      'line_items[0][price]': 'price_top_up',
      'line_items[0][quantity]': '1',
      client_reference_id: TENANT,
      customer: 'cus_1',
      'metadata[tenant_id]': TENANT,
      'metadata[top_up]': 'MESSAGES_1000',
      'payment_intent_data[metadata][tenant_id]': TENANT,
      'payment_intent_data[metadata][top_up]': 'MESSAGES_1000',
      locale: 'it',
      success_url: `https://app.catalogorosso.com${BILLING_PATH}?top_up=success`,
      cancel_url: `https://app.catalogorosso.com${BILLING_PATH}?top_up=cancelled`,
    });
  });

  it('leaves a language Checkout does not share with us to Stripe', () => {
    expect(topUp('de').locale).toBe('auto');
  });

  it('names its winery where the webhook reads one back', () => {
    const params = topUpSessionParams({
      tenantId: TENANT,
      priceId: 'price_top_up',
      customerId: 'cus_1',
      locale: 'it',
      dashboardOrigin: 'https://app.catalogorosso.com',
    });

    expect(tenantOfStripeEvent({ data: { object: params } })).toBe(TENANT);
  });
});
