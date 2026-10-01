import { describe, expect, it } from 'vitest';

import { readPaidInvoice } from '../../src/billing/charges.js';
import { readBillingEvent, tenantOfStripeEvent } from '../../src/billing/stripe-events.js';
import {
  DEV_TRANSITIONS,
  syntheticBillingEvent,
  SyntheticEventRefused,
} from '../../src/billing/synthetic-events.js';

/**
 * The Stripe-shaped events the fixtures write (P5-14). Each is asserted by
 * reading it back with the readers a signed delivery goes through: an event
 * they cannot read is a fixture that proves nothing.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const BOUND = { tenantId: TENANT, customerId: 'cus_1', subscriptionId: 'sub_1', at: 1_790_000_000 };

describe('each transition, as the webhook reads it', () => {
  it('activates through a paid Checkout naming the winery and the plan', () => {
    const event = syntheticBillingEvent('activate', {
      ...BOUND,
      customerId: null,
      subscriptionId: null,
      plan: 'ECOMMERCE',
    });

    expect(event.type).toBe('checkout.session.completed');
    expect(tenantOfStripeEvent(event.payload)).toBe(TENANT);
    expect(readBillingEvent(event.payload)?.event).toMatchObject({
      kind: 'checkout_completed',
      plan: 'ECOMMERCE',
      paid: true,
      occurredAt: new Date(1_790_000_000 * 1000),
    });
  });

  it('activates a winery that was a customer before as the same customer', () => {
    const event = syntheticBillingEvent('activate', { ...BOUND, subscriptionId: null });

    expect(readBillingEvent(event.payload)?.event).toMatchObject({ customerId: 'cus_1' });
  });

  it.each<[string, (typeof DEV_TRANSITIONS)[number], string]>([
    ['fails a payment', 'fail_payment', 'payment_failed'],
    ['recovers', 'recover', 'payment_succeeded'],
    ['ends the subscription', 'end_subscription', 'subscription_ended'],
  ])('%s on the subscription on file', (_what, transition, kind) => {
    const event = syntheticBillingEvent(transition, BOUND);

    expect(tenantOfStripeEvent(event.payload)).toBe(TENANT);
    expect(readBillingEvent(event.payload)?.event).toMatchObject({
      kind,
      customerId: 'cus_1',
      subscriptionId: 'sub_1',
    });
  });

  it('recovers with an invoice the e-invoicing ledger reads as paid (P5-03a)', () => {
    expect(readPaidInvoice(syntheticBillingEvent('recover', BOUND).payload)).toMatchObject({
      source: 'invoice',
      amountCents: 2_900,
      customerId: 'cus_1',
    });
  });

  it('writes test mode, under ids that say they are ours', () => {
    const event = syntheticBillingEvent('fail_payment', BOUND);

    expect(event.eventId).toMatch(/^evt_dev_[0-9a-f]{32}$/u);
    expect(readBillingEvent(event.payload)?.livemode).toBe(false);
  });

  it('never reuses an event id, or the claim would read the second as a duplicate', () => {
    expect(syntheticBillingEvent('recover', BOUND).eventId).not.toBe(
      syntheticBillingEvent('recover', BOUND).eventId,
    );
  });
});

describe('a transition that cannot be written', () => {
  it('refuses a second activation while a subscription is on file', () => {
    expect(() => syntheticBillingEvent('activate', BOUND)).toThrow(SyntheticEventRefused);
  });

  it.each(['fail_payment', 'recover', 'end_subscription'] as const)(
    'refuses %s with no subscription to act on',
    (transition) => {
      expect(() => syntheticBillingEvent(transition, { ...BOUND, subscriptionId: null })).toThrow(
        /activate it first/u,
      );
    },
  );
});
