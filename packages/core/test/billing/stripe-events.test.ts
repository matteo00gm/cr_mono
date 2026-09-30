import { describe, expect, it } from 'vitest';

import {
  BILLING_EVENT_TYPES,
  readBillingEvent,
  tenantOfStripeEvent,
} from '../../src/billing/stripe-events.js';

/**
 * Which winery a verified Stripe event names (P5-04, ADR 0029).
 *
 * The one read of a tenant id from a request body, so the cases are mostly
 * refusals: every place and spelling we did not write is ignored, and anything
 * inconsistent names nobody.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER = '22222222-2222-4222-8222-222222222222';

const event = (object: Record<string, unknown>) => ({
  id: 'evt_1',
  type: 'test.event',
  data: { object },
});

describe('the winery an event names', () => {
  it('is read from a completed Checkout session, where both of our fields agree', () => {
    expect(
      tenantOfStripeEvent(
        event({ client_reference_id: TENANT, metadata: { tenant_id: TENANT, plan: 'CANTINA' } }),
      ),
    ).toBe(TENANT);
  });

  it('is read from a subscription’s metadata', () => {
    expect(tenantOfStripeEvent(event({ metadata: { tenant_id: TENANT } }))).toBe(TENANT);
  });

  it('is read from an invoice, through the subscription it bills', () => {
    expect(
      tenantOfStripeEvent(
        event({
          metadata: {},
          parent: { subscription_details: { metadata: { tenant_id: TENANT } } },
        }),
      ),
    ).toBe(TENANT);
  });

  it('is read from a client reference alone', () => {
    expect(tenantOfStripeEvent(event({ client_reference_id: TENANT }))).toBe(TENANT);
  });
});

describe('an event that names nobody', () => {
  it.each([
    ['carries nothing of ours', event({ metadata: { order: '42' } })],
    [
      'has null where ours would be',
      event({ client_reference_id: null, metadata: null, parent: null }),
    ],
    ['spells it any other way', event({ metadata: { tenantId: TENANT, tenant: TENANT } })],
    ['puts it anywhere else in the object', event({ customer: TENANT, tenant_id: TENANT })],
    ['names something that is not a UUID', event({ metadata: { tenant_id: 'acme' } })],
    ['names a UUID with something after it', event({ metadata: { tenant_id: `${TENANT}; drop` } })],
    ['names it as a number', event({ metadata: { tenant_id: 42 } })],
    ['is not an event', { hello: 'world' }],
    ['is not an object', 'evt_1'],
    ['is nothing', undefined],
  ])('when it %s', (_what, payload) => {
    expect(tenantOfStripeEvent(payload)).toBeUndefined();
  });

  it('when its places disagree, because one of them is not ours', () => {
    expect(
      tenantOfStripeEvent(event({ client_reference_id: TENANT, metadata: { tenant_id: OTHER } })),
    ).toBeUndefined();
    expect(
      tenantOfStripeEvent(
        event({
          metadata: { tenant_id: TENANT },
          parent: { subscription_details: { metadata: { tenant_id: OTHER } } },
        }),
      ),
    ).toBeUndefined();
  });

  it('when one place is ours and another holds something malformed', () => {
    expect(
      tenantOfStripeEvent(event({ client_reference_id: TENANT, metadata: { tenant_id: 'acme' } })),
    ).toBeUndefined();
  });
});

/* ------------------------------------------------------------ readBillingEvent */

const CREATED = 1_790_000_000;

const stripeEvent = (type: string, object: Record<string, unknown>, livemode = false) => ({
  id: 'evt_1',
  object: 'event',
  type,
  created: CREATED,
  livemode,
  data: { object },
});

const session = (overrides: Record<string, unknown> = {}) => ({
  object: 'checkout.session',
  mode: 'subscription',
  customer: 'cus_1',
  subscription: 'sub_1',
  payment_status: 'paid',
  client_reference_id: TENANT,
  metadata: { tenant_id: TENANT, plan: 'ECOMMERCE' },
  ...overrides,
});

const subscription = (overrides: Record<string, unknown> = {}) => ({
  object: 'subscription',
  id: 'sub_1',
  customer: 'cus_1',
  status: 'active',
  metadata: { tenant_id: TENANT },
  items: { data: [{ price: { id: 'price_1', lookup_key: 'cantina_monthly_eur' } }] },
  ...overrides,
});

/** An invoice at the pinned version: its subscription under `parent` (2025 onwards). */
const invoice = (overrides: Record<string, unknown> = {}) => ({
  object: 'invoice',
  customer: 'cus_1',
  parent: {
    type: 'subscription_details',
    subscription_details: { subscription: 'sub_1', metadata: { tenant_id: TENANT } },
  },
  ...overrides,
});

const common = {
  occurredAt: new Date(CREATED * 1000),
  customerId: 'cus_1',
  subscriptionId: 'sub_1',
};

describe('a billing event, read', () => {
  it('is a completed Checkout with its plan, paid', () => {
    expect(readBillingEvent(stripeEvent('checkout.session.completed', session()))).toEqual({
      livemode: false,
      event: { kind: 'checkout_completed', ...common, plan: 'ECOMMERCE', paid: true },
    });
  });

  it('is a Checkout that settles later, unpaid until then', () => {
    expect(
      readBillingEvent(
        stripeEvent('checkout.session.completed', session({ payment_status: 'unpaid' })),
      ),
    ).toMatchObject({ event: { paid: false } });
  });

  it('is a paid Checkout when its later payment settles', () => {
    expect(
      readBillingEvent(stripeEvent('checkout.session.async_payment_succeeded', session())),
    ).toMatchObject({ event: { kind: 'checkout_completed', paid: true } });
  });

  it('counts a Checkout that needed no payment as paid', () => {
    expect(
      readBillingEvent(
        stripeEvent(
          'checkout.session.completed',
          session({ payment_status: 'no_payment_required' }),
        ),
      ),
    ).toMatchObject({ event: { paid: true } });
  });

  it('carries no plan from a Checkout whose metadata names none of ours', () => {
    expect(
      readBillingEvent(
        stripeEvent('checkout.session.completed', session({ metadata: { plan: 'ENTERPRISE' } })),
      ),
    ).toMatchObject({ event: { plan: undefined } });
  });

  it('is nothing for a one-off Checkout — P5-11a’s top-ups are paid in payment mode', () => {
    expect(
      readBillingEvent(stripeEvent('checkout.session.completed', session({ mode: 'payment' }))),
    ).toBeUndefined();
  });

  it.each(['customer.subscription.created', 'customer.subscription.updated'])(
    'is a changed subscription for %s, with its plan from the price',
    (type) => {
      expect(readBillingEvent(stripeEvent(type, subscription({ status: 'past_due' })))).toEqual({
        livemode: false,
        event: {
          kind: 'subscription_changed',
          ...common,
          stripeStatus: 'past_due',
          plan: 'CANTINA',
        },
      });
    },
  );

  it('carries no plan from a price that is not ours', () => {
    expect(
      readBillingEvent(
        stripeEvent(
          'customer.subscription.updated',
          subscription({ items: { data: [{ price: { lookup_key: null } }] } }),
        ),
      ),
    ).toMatchObject({ event: { plan: undefined } });
  });

  it('is an ended subscription', () => {
    expect(readBillingEvent(stripeEvent('customer.subscription.deleted', subscription()))).toEqual({
      livemode: false,
      event: { kind: 'subscription_ended', ...common },
    });
  });

  it('is a failed payment, from an invoice at the pinned version', () => {
    expect(readBillingEvent(stripeEvent('invoice.payment_failed', invoice()))).toEqual({
      livemode: false,
      event: { kind: 'payment_failed', ...common },
    });
  });

  it.each(['invoice.paid', 'invoice.payment_succeeded'])(
    'is a successful payment for %s',
    (type) => {
      expect(readBillingEvent(stripeEvent(type, invoice()))).toMatchObject({
        event: { kind: 'payment_succeeded', subscriptionId: 'sub_1' },
      });
    },
  );

  it('reads an invoice’s subscription where older versions carried it, too', () => {
    expect(
      readBillingEvent(
        stripeEvent('invoice.paid', invoice({ parent: null, subscription: 'sub_1' })),
      ),
    ).toMatchObject({ event: { subscriptionId: 'sub_1' } });
  });

  it('is nothing for an invoice that bills no subscription', () => {
    expect(
      readBillingEvent(stripeEvent('invoice.paid', invoice({ parent: null, subscription: null }))),
    ).toBeUndefined();
  });

  it('says which mode it came from', () => {
    expect(readBillingEvent(stripeEvent('invoice.paid', invoice(), true))?.livemode).toBe(true);
  });

  it.each([
    ['a type the machine does not act on', stripeEvent('customer.created', { id: 'cus_1' })],
    [
      'a Checkout with no subscription',
      stripeEvent('checkout.session.completed', session({ subscription: null })),
    ],
    [
      'a subscription with no customer',
      stripeEvent('customer.subscription.updated', subscription({ customer: undefined })),
    ],
    [
      'a customer expanded into an object',
      stripeEvent('invoice.paid', invoice({ customer: { id: 'cus_1' } })),
    ],
    [
      'an unknown payment status',
      stripeEvent('checkout.session.completed', session({ payment_status: 'maybe' })),
    ],
    [
      'an event with no creation time',
      { type: 'invoice.paid', livemode: false, data: { object: invoice() } },
    ],
    ['not an event at all', 'invoice.paid'],
  ])('is nothing for %s', (_what, payload) => {
    expect(readBillingEvent(payload)).toBeUndefined();
  });

  it('acts on exactly the types it reads', () => {
    expect([...BILLING_EVENT_TYPES].sort()).toEqual([
      'checkout.session.async_payment_succeeded',
      'checkout.session.completed',
      'customer.subscription.created',
      'customer.subscription.deleted',
      'customer.subscription.updated',
      'invoice.paid',
      'invoice.payment_failed',
      'invoice.payment_succeeded',
    ]);
  });
});
