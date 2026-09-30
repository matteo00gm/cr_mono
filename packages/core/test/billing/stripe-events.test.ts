import { describe, expect, it } from 'vitest';

import { tenantOfStripeEvent } from '../../src/billing/stripe-events.js';

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
