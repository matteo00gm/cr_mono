import { randomUUID } from 'node:crypto';

import { PLANS, type PlanId } from '../plans.js';

import { STRIPE_PLAN_KEY, STRIPE_TENANT_KEY } from './checkout.js';

/**
 * Stripe-shaped events we write ourselves, for the non-production fixtures and
 * the dev endpoint (P5-14).
 *
 * **They take the webhook path, not a shortcut.** Each is recorded through the
 * same port a signed delivery reaches — attributed by `tenantOfStripeEvent`,
 * claimed once, run through the state machine, audited — so a fixture proves
 * the path rather than skipping it, and a state the machine would refuse is
 * refused here too. Only the signature is missing, and the dev surface that
 * records them does not exist in production (P5-14).
 *
 * The shapes are the ones the readers parse at the pinned API version
 * (`readBillingEvent`, `readPaidInvoice`), test mode, with ids that say what
 * they are: `evt_dev_…`, `cus_dev_…`, `sub_dev_…`, `in_dev_…`.
 */

export const DEV_TRANSITIONS = ['activate', 'fail_payment', 'recover', 'end_subscription'] as const;
export type DevTransition = (typeof DEV_TRANSITIONS)[number];

export interface SyntheticEvent {
  readonly eventId: string;
  readonly type: string;
  readonly payload: unknown;
}

export interface SyntheticContext {
  readonly tenantId: string;
  /** The customer on file, or `null` before the first Checkout binds one. */
  readonly customerId: string | null;
  /** The subscription on file, or `null` without one. */
  readonly subscriptionId: string | null;
  /** The plan an `activate` buys. */
  readonly plan?: PlanId | undefined;
  /** When it happened, in Stripe's seconds. Defaults to now. */
  readonly at?: number | undefined;
}

/** Why a transition cannot be written for a winery as it stands. */
export class SyntheticEventRefused extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SyntheticEventRefused';
  }
}

const dev = (prefix: string): string => `${prefix}_dev_${randomUUID().replaceAll('-', '')}`;

const envelope = (type: string, object: Record<string, unknown>, at: number): SyntheticEvent => {
  const eventId = dev('evt');

  return {
    eventId,
    type,
    payload: { id: eventId, object: 'event', type, created: at, livemode: false, data: { object } },
  };
};

/**
 * The event that moves a winery along one transition — or a refusal naming
 * what is missing, when the transition needs a subscription it does not have.
 */
export const syntheticBillingEvent = (
  transition: DevTransition,
  {
    tenantId,
    customerId,
    subscriptionId,
    plan = 'CANTINA',
    at = Math.floor(Date.now() / 1000),
  }: SyntheticContext,
): SyntheticEvent => {
  const tenantMetadata = { [STRIPE_TENANT_KEY]: tenantId };

  if (transition === 'activate') {
    if (subscriptionId !== null) {
      throw new SyntheticEventRefused(
        'This winery already has a subscription; end it before activating again.',
      );
    }

    const metadata = { ...tenantMetadata, [STRIPE_PLAN_KEY]: plan };

    return envelope(
      'checkout.session.completed',
      {
        id: dev('cs'),
        object: 'checkout.session',
        mode: 'subscription',
        customer: customerId ?? dev('cus'),
        subscription: dev('sub'),
        payment_status: 'paid',
        client_reference_id: tenantId,
        metadata,
      },
      at,
    );
  }

  if (customerId === null || subscriptionId === null) {
    throw new SyntheticEventRefused(
      `This winery has no subscription for "${transition}"; activate it first.`,
    );
  }

  const parent = {
    subscription_details: { subscription: subscriptionId, metadata: tenantMetadata },
  };

  switch (transition) {
    case 'fail_payment':
      return envelope(
        'invoice.payment_failed',
        { id: dev('in'), object: 'invoice', customer: customerId, parent },
        at,
      );

    case 'recover':
      return envelope(
        'invoice.paid',
        {
          id: dev('in'),
          object: 'invoice',
          customer: customerId,
          amount_paid: PLANS[plan].amountCents,
          currency: 'eur',
          status_transitions: { paid_at: at },
          parent,
        },
        at,
      );

    case 'end_subscription':
      return envelope(
        'customer.subscription.deleted',
        {
          id: subscriptionId,
          object: 'subscription',
          customer: customerId,
          status: 'canceled',
          metadata: tenantMetadata,
          items: { data: [{ price: { lookup_key: PLANS[plan].lookupKey } }] },
        },
        at,
      );
  }
};
