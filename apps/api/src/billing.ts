import type { BillingCheckoutResponse } from '@catalogorosso/api-client';
import {
  checkoutSessionParams,
  ConflictError,
  NotFoundError,
  PLANS,
  type PlanId,
} from '@catalogorosso/core';
import { readBillingState, withTenant, type BillingState } from '@catalogorosso/db';
import { z } from 'zod';

import { logger } from './middleware/logger.js';
import type { StripeClient } from './stripe.js';

/**
 * Buying a plan (P5-02).
 *
 * **Checkout starts a purchase and changes nothing of ours.** It returns a
 * Stripe-hosted page; the plan and the status move only when Stripe's webhook
 * says the subscription exists and is paid for (P5-05), so there is one writer
 * of billing state and one path to test — and a seller who closes the tab has
 * bought nothing and been granted nothing.
 */

/** No Stripe key on this deployment, or no price under the plan's lookup key. */
export const BILLING_UNAVAILABLE =
  'Payments are not set up on this service yet, so a plan cannot be bought here. Contact support.';

/**
 * A second subscription would bill the winery twice for one widget.
 *
 * Moving between plans is a change to the subscription they have (P5-09),
 * prorated by Stripe, rather than a second purchase beside it.
 */
export const ALREADY_SUBSCRIBED =
  'This winery already has a subscription. To move to another plan, change plan on the ' +
  'Fatturazione screen rather than buying a second one.';

export interface BillingPort {
  readonly checkout: (tenantId: string, plan: PlanId) => Promise<BillingCheckoutResponse>;
}

/** The port with nothing behind it: a wiring error, loudly, never a plausible answer. */
export class BillingPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No billing port was supplied to createApp, so a plan cannot be bought. ' +
        'This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'BillingPortNotConfiguredError';
  }
}

export const unconfiguredBilling: BillingPort = {
  checkout: () => Promise.reject(new BillingPortNotConfiguredError()),
};

export interface BillingDeps {
  /** Absent on a deployment with no Stripe key: every purchase is refused, plainly. */
  readonly stripe?: StripeClient | undefined;
  /** Where Stripe sends the owner back to, finished or not. */
  readonly dashboardOrigin: string;
  readonly readState?: ((tenantId: string) => Promise<BillingState | undefined>) | undefined;
}

/** Only the fields read: a price's id, and the key it was found under. */
const priceList = z.object({
  data: z.array(z.object({ id: z.string(), lookup_key: z.string().nullable() })),
});

const checkoutSession = z.object({ id: z.string(), url: z.url() });

export const createBillingPort = ({
  stripe,
  dashboardOrigin,
  readState = (tenantId) => withTenant(tenantId, readBillingState),
}: BillingDeps): BillingPort => ({
  async checkout(tenantId, plan) {
    if (stripe === undefined) throw new ConflictError(BILLING_UNAVAILABLE);

    const state = await readState(tenantId);

    /* The guard resolved this tenant a moment ago; absent is a race with deletion. */
    if (state === undefined) throw new NotFoundError();

    if (state.stripeSubscriptionId !== null) throw new ConflictError(ALREADY_SUBSCRIBED);

    const { lookupKey } = PLANS[plan];
    const prices = await stripe.get(
      '/v1/prices',
      { lookup_keys: [lookupKey], active: true, limit: 1 },
      priceList,
    );
    const price = prices.data.find((candidate) => candidate.lookup_key === lookupKey);

    if (price === undefined) {
      /*
       * The account has never had `stripe-setup.mjs --apply` run against it.
       * The seller is told what they can act on; the operator is told what to
       * run, by a log line an alarm can match.
       */
      logger.error(
        { kind: 'stripe_price_missing', type: plan },
        'no active Stripe price under a plan lookup key; run scripts/stripe-setup.mjs (P5-01)',
      );

      throw new ConflictError(BILLING_UNAVAILABLE);
    }

    const session = await stripe.post(
      '/v1/checkout/sessions',
      checkoutSessionParams({
        tenantId,
        plan,
        priceId: price.id,
        customerId: state.stripeCustomerId,
        locale: state.locale,
        dashboardOrigin,
      }),
      checkoutSession,
    );

    return { url: session.url };
  },
});
