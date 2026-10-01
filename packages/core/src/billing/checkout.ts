import { TOP_UP, type PlanId } from '../plans.js';

import type { StripeParams } from './stripe-form.js';
import { TAX_CUSTOM_FIELDS } from './tax-details.js';

/**
 * The Checkout session a winery is sent to (P5-02).
 *
 * **The tenant travels in Stripe-signed data, written by us.** Checkout is
 * created server-side from the session's own tenant (P0-48), never from
 * anything the browser sent, and the id goes in three places a webhook can
 * read it back from: `client_reference_id` on the session, and `tenant_id` in
 * the metadata of the session and of the subscription it creates. Every later
 * event about that subscription carries the subscription's metadata, so the
 * webhook (P5-03 onwards) finds the tenant without a lookup that reads across
 * wineries — and checks the customer against the one on file before applying
 * anything.
 */

/** Where the dashboard shows billing, and where Stripe sends the seller back to. */
export const BILLING_PATH = '/fatturazione';

/** The metadata keys the webhook reads back. One definition for both ends. */
export const STRIPE_TENANT_KEY = 'tenant_id';
export const STRIPE_PLAN_KEY = 'plan';
/** On a top-up's session (P5-11a): which top-up was bought. */
export const STRIPE_TOP_UP_KEY = 'top_up';

export interface CheckoutRequest {
  readonly tenantId: string;
  readonly plan: PlanId;
  /** The active price under the plan's lookup key, as Stripe answered it. */
  readonly priceId: string;
  /** Reused when the winery has been a customer before, so Stripe has one of them. */
  readonly customerId: string | null;
  /** The winery's locale; Checkout is shown in it when Stripe has it. */
  readonly locale: string;
  readonly dashboardOrigin: string;
}

/** Checkout's own languages that we also speak; anything else is Stripe's call. */
const STRIPE_LOCALES = new Set(['it', 'en']);

export const checkoutSessionParams = ({
  tenantId,
  plan,
  priceId,
  customerId,
  locale,
  dashboardOrigin,
}: CheckoutRequest): StripeParams => {
  const metadata = { [STRIPE_TENANT_KEY]: tenantId, [STRIPE_PLAN_KEY]: plan };

  return {
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: tenantId,
    customer: customerId ?? undefined,
    metadata,
    subscription_data: { metadata },
    /* What an Italian business needs on its invoice, optional for everyone (P5-02a). */
    custom_fields: TAX_CUSTOM_FIELDS,
    locale: STRIPE_LOCALES.has(locale) ? locale : 'auto',
    success_url: `${dashboardOrigin}${BILLING_PATH}?checkout=success`,
    cancel_url: `${dashboardOrigin}${BILLING_PATH}?checkout=cancelled`,
  };
};

export interface TopUpRequest {
  readonly tenantId: string;
  /** The active price under the top-up's lookup key. */
  readonly priceId: string;
  /** Required: a top-up is for a winery that already pays, so it has a customer. */
  readonly customerId: string;
  readonly locale: string;
  readonly dashboardOrigin: string;
}

/**
 * The Checkout session for messages bought on top of the plan (P5-11a).
 *
 * **A one-time payment, not a subscription**: `mode: 'payment'`, for the
 * customer the winery already is, so the purchase lands on its own account and
 * the webhook can bind it to the customer on file. The tenant travels as it
 * does for a plan — `client_reference_id` and the session's metadata — and the
 * metadata says which top-up, which is how the webhook tells this Checkout from
 * a plan's. The payment intent carries the same, so a refund issued from the
 * Dashboard can be traced back to a winery.
 */
export const topUpSessionParams = ({
  tenantId,
  priceId,
  customerId,
  locale,
  dashboardOrigin,
}: TopUpRequest): StripeParams => {
  const metadata = { [STRIPE_TENANT_KEY]: tenantId, [STRIPE_TOP_UP_KEY]: TOP_UP.id };

  return {
    mode: 'payment',
    line_items: [{ price: priceId, quantity: 1 }],
    client_reference_id: tenantId,
    customer: customerId,
    metadata,
    payment_intent_data: { metadata },
    locale: STRIPE_LOCALES.has(locale) ? locale : 'auto',
    success_url: `${dashboardOrigin}${BILLING_PATH}?top_up=success`,
    cancel_url: `${dashboardOrigin}${BILLING_PATH}?top_up=cancelled`,
  };
};
