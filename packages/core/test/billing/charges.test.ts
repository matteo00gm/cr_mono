import { describe, expect, it } from 'vitest';

import { needsEInvoice, readPaidInvoice } from '../../src/billing/charges.js';

/**
 * The charges a FatturaPA may be owed for (P5-03a): a paid invoice read as one,
 * and the details that call for an electronic invoice.
 */

const CREATED = 1_790_000_000;
const PAID_AT = 1_789_999_990;

const event = (type: string, object: Record<string, unknown>, livemode = false) => ({
  id: 'evt_1',
  type,
  created: CREATED,
  livemode,
  data: { object },
});

const invoice = (overrides: Record<string, unknown> = {}) => ({
  id: 'in_1',
  customer: 'cus_1',
  amount_paid: 2900,
  currency: 'EUR',
  status_transitions: { paid_at: PAID_AT },
  ...overrides,
});

describe('a paid invoice', () => {
  it.each(['invoice.paid', 'invoice.payment_succeeded'])(
    'is a charge under %s, at what was paid and when',
    (type) => {
      expect(readPaidInvoice(event(type, invoice(), true))).toEqual({
        stripeObjectId: 'in_1',
        source: 'invoice',
        customerId: 'cus_1',
        amountCents: 2900,
        currency: 'eur',
        paidAt: new Date(PAID_AT * 1000),
        livemode: true,
      });
    },
  );

  it('is dated by the event when Stripe gives no payment time', () => {
    expect(
      readPaidInvoice(event('invoice.paid', invoice({ status_transitions: null })))?.paidAt,
    ).toEqual(new Date(CREATED * 1000));
  });

  it.each([
    ['an invoice of nothing', event('invoice.paid', invoice({ amount_paid: 0 }))],
    ['a failed payment', event('invoice.payment_failed', invoice())],
    ['a Checkout', event('checkout.session.completed', invoice())],
    ['an invoice with no amount', event('invoice.paid', invoice({ amount_paid: undefined }))],
    ['something that is not an event', { hello: 'world' }],
  ])('is nothing for %s', (_what, payload) => {
    expect(readPaidInvoice(payload)).toBeUndefined();
  });
});

describe('an electronic invoice', () => {
  const none = { vatId: null, sdiCode: null, pecAddress: null };

  it('is owed to a business that said who it is and where to deliver', () => {
    expect(needsEInvoice({ ...none, vatId: '12345678903', sdiCode: 'M5UXCR1' })).toBe(true);
    expect(needsEInvoice({ ...none, vatId: '12345678903', pecAddress: 'f@c.pec.it' })).toBe(true);
  });

  it.each([
    ['nothing at all', none],
    ['an identity with nowhere to deliver', { ...none, vatId: '12345678903' }],
    ['somewhere to deliver and no identity', { ...none, sdiCode: 'M5UXCR1' }],
  ])('is not owed for %s', (_what, details) => {
    expect(needsEInvoice(details)).toBe(false);
  });
});
