import type {
  BillingCheckoutResponse,
  BillingPlanChangeResponse,
  BillingPortalResponse,
} from '@catalogorosso/api-client';
import {
  BILLING_PATH,
  checkoutSessionParams,
  ConflictError,
  downgradeBlockers,
  downgradeRefusal,
  isDowngrade,
  NotFoundError,
  planForLookupKey,
  PLANS,
  type PlanId,
} from '@catalogorosso/core';
import {
  readBillingState,
  readPlanFootprint,
  withTenant,
  type BillingState,
} from '@catalogorosso/db';
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

/**
 * A winery that has never bought anything has no Stripe customer, and so no
 * account for the portal to open (P5-08).
 */
export const NO_BILLING_ACCOUNT =
  'This winery has not bought a plan yet, so there is no billing account to manage. ' +
  'Choose a plan on the Fatturazione screen first.';

/** A plan change needs a subscription to change (P5-09). */
export const NO_SUBSCRIPTION =
  'This winery has no subscription to change. Choose a plan on the Fatturazione screen first.';

export const SAME_PLAN = 'This winery is already on that plan.';

export interface BillingPort {
  readonly checkout: (tenantId: string, plan: PlanId) => Promise<BillingCheckoutResponse>;
  /**
   * Move to another plan (P5-09): an upgrade now, prorated; a downgrade at the
   * end of the period already paid for. Either way our plan record moves only
   * when Stripe's webhook confirms it (P5-05).
   */
  readonly changePlan: (tenantId: string, plan: PlanId) => Promise<BillingPlanChangeResponse>;
  /** Stripe's Billing Portal, for the payment method, invoices and cancellation (P5-08). */
  readonly portal: (tenantId: string) => Promise<BillingPortalResponse>;
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
  changePlan: () => Promise.reject(new BillingPortNotConfiguredError()),
  portal: () => Promise.reject(new BillingPortNotConfiguredError()),
};

export interface BillingDeps {
  /** Absent on a deployment with no Stripe key: every purchase is refused, plainly. */
  readonly stripe?: StripeClient | undefined;
  /** Where Stripe sends the owner back to, finished or not. */
  readonly dashboardOrigin: string;
  readonly readState?: ((tenantId: string) => Promise<BillingState | undefined>) | undefined;
  /** What the winery holds that a plan caps (P5-10). */
  readonly readFootprint?:
    | ((tenantId: string) => Promise<{ readonly wines: number; readonly domains: number }>)
    | undefined;
}

/** Only the fields read: a price's id, and the key it was found under. */
const priceList = z.object({
  data: z.array(z.object({ id: z.string(), lookup_key: z.string().nullable() })),
});

const checkoutSession = z.object({ id: z.string(), url: z.url() });

/**
 * A subscription, as far as a plan change reads it: its one item — the price
 * and the period it is paid to, which the pinned version carries on the item —
 * and the schedule a pending downgrade left on it.
 */
const subscriptionItem = z.object({
  id: z.string(),
  current_period_end: z.number().int(),
  price: z.object({ id: z.string(), lookup_key: z.string().nullable() }),
});

/** At least one of each: a tuple with a rest, so the type knows what the parse checked. */
const subscription = z.object({
  id: z.string(),
  schedule: z.string().nullable(),
  items: z.object({ data: z.tuple([subscriptionItem], subscriptionItem) }),
});

const phase = z.object({ start_date: z.number().int(), end_date: z.number().int() });

const schedule = z.object({ id: z.string(), phases: z.tuple([phase], phase) });

const acknowledged = z.object({ id: z.string() });

/**
 * The active price under a plan's lookup key (P5-01), or a refusal that tells
 * the owner payments are unavailable and the operator what to run.
 */
const currentPriceId = async (stripe: StripeClient, plan: PlanId): Promise<string> => {
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

  return price.id;
};

/**
 * A portal session, with the configuration it was opened under expanded — the
 * one feature we read is whether the portal lets the customer change plan.
 */
const portalSession = z.object({
  url: z.url(),
  configuration: z.object({
    features: z.object({
      subscription_update: z.object({ enabled: z.boolean() }),
    }),
  }),
});

export const createBillingPort = ({
  stripe,
  dashboardOrigin,
  readState = (tenantId) => withTenant(tenantId, readBillingState),
  readFootprint = (tenantId) => withTenant(tenantId, readPlanFootprint),
}: BillingDeps): BillingPort => ({
  async checkout(tenantId, plan) {
    if (stripe === undefined) throw new ConflictError(BILLING_UNAVAILABLE);

    const state = await readState(tenantId);

    /* The guard resolved this tenant a moment ago; absent is a race with deletion. */
    if (state === undefined) throw new NotFoundError();

    if (state.stripeSubscriptionId !== null) throw new ConflictError(ALREADY_SUBSCRIBED);

    const priceId = await currentPriceId(stripe, plan);

    const session = await stripe.post(
      '/v1/checkout/sessions',
      checkoutSessionParams({
        tenantId,
        plan,
        priceId,
        customerId: state.stripeCustomerId,
        locale: state.locale,
        dashboardOrigin,
      }),
      checkoutSession,
    );

    return { url: session.url };
  },

  async changePlan(tenantId, plan) {
    if (stripe === undefined) throw new ConflictError(BILLING_UNAVAILABLE);

    const state = await readState(tenantId);

    if (state === undefined) throw new NotFoundError();
    if (state.stripeSubscriptionId === null) throw new ConflictError(NO_SUBSCRIPTION);

    const live = await stripe.get(
      `/v1/subscriptions/${encodeURIComponent(state.stripeSubscriptionId)}`,
      {},
      subscription,
    );
    /* The schema's tuple: a subscription with no item is a response we cannot read. */
    const [item] = live.items.data;

    /*
     * The plan the winery is on, as Stripe bills it: our record moves only on
     * the webhook, so a change made a moment ago is Stripe's before it is ours.
     */
    const current = planForLookupKey(item.price.lookup_key) ?? state.plan;

    if (current === plan) throw new ConflictError(SAME_PLAN);

    const down = current !== null && isDowngrade(current, plan);

    /*
     * **A downgrade the winery does not fit is refused before anything is
     * written** (P5-10) — naming what to reduce and by how much, and leaving
     * any downgrade already pending exactly as it was.
     */
    if (down) {
      const blockers = downgradeBlockers(await readFootprint(tenantId), plan);

      if (blockers.length > 0) throw new ConflictError(downgradeRefusal(plan, blockers));
    }

    const priceId = await currentPriceId(stripe, plan);

    /*
     * **Any pending downgrade is released first**, whichever way this goes: an
     * upgrade replaces it, and a second downgrade is built afresh rather than
     * patched onto a schedule whose phases we would have to read and trust.
     */
    if (live.schedule !== null) {
      await stripe.post(
        `/v1/subscription_schedules/${encodeURIComponent(live.schedule)}/release`,
        {},
        acknowledged,
      );
    }

    if (!down) {
      /*
       * **Up, now, prorated**: the winery pays the difference for the rest of
       * the period and gets the higher limits when Stripe's webhook confirms
       * it — not before, so our limits never exceed what Stripe agrees is paid.
       */
      await stripe.post(
        `/v1/subscriptions/${encodeURIComponent(live.id)}`,
        {
          items: [{ id: item.id, price: priceId }],
          proration_behavior: 'create_prorations',
        },
        acknowledged,
      );

      return { plan, effective: 'now', effectiveAt: null };
    }

    /*
     * **Down, at the end of the period already paid for**, and never refunded:
     * a schedule whose first phase is what the winery has now, to the end of
     * its period, and whose second is the lower price. Stripe moves it on the
     * day, and the webhook that follows moves our record.
     */
    const created = await stripe.post(
      '/v1/subscription_schedules',
      { from_subscription: live.id },
      schedule,
    );
    const [paidPhase] = created.phases;

    await stripe.post(
      `/v1/subscription_schedules/${encodeURIComponent(created.id)}`,
      {
        end_behavior: 'release',
        phases: [
          {
            items: [{ price: item.price.id, quantity: 1 }],
            start_date: paidPhase.start_date,
            end_date: paidPhase.end_date,
          },
          {
            items: [{ price: priceId, quantity: 1 }],
            proration_behavior: 'none',
          },
        ],
      },
      acknowledged,
    );

    return {
      plan,
      effective: 'period_end',
      effectiveAt: new Date(item.current_period_end * 1000).toISOString(),
    };
  },

  async portal(tenantId) {
    if (stripe === undefined) throw new ConflictError(BILLING_UNAVAILABLE);

    const state = await readState(tenantId);

    if (state === undefined) throw new NotFoundError();
    if (state.stripeCustomerId === null) throw new ConflictError(NO_BILLING_ACCOUNT);

    const session = await stripe.post(
      '/v1/billing_portal/sessions',
      {
        customer: state.stripeCustomerId,
        return_url: `${dashboardOrigin}${BILLING_PATH}`,
        locale: state.locale === 'en' ? 'en' : 'it',
        expand: ['configuration'],
      },
      portalSession,
    );

    /*
     * **A portal that lets the customer change plan is refused, loudly.** Plan
     * changes go through P5-09 — prorated up, at period end down — and past
     * P5-10's guard, which refuses a downgrade the catalogue or the domains
     * would not fit. A portal configured to switch plans would walk around
     * both. It is a Dashboard setting, so it is checked on every session
     * rather than trusted: the operator hears it from the log, the owner is
     * told payments are unavailable, and nothing is handed out.
     */
    if (session.configuration.features.subscription_update.enabled) {
      logger.error(
        { kind: 'stripe_portal_allows_plan_changes' },
        'the Stripe Billing Portal lets customers change plan; switch it off in the Dashboard (P5-08)',
      );

      throw new ConflictError(BILLING_UNAVAILABLE);
    }

    return { url: session.url };
  },
});

/**
 * Puts a winery's subscription back on a plan's price, with nothing prorated
 * (P5-10).
 *
 * The other half of a downgrade refused as it applies: Stripe moved the
 * subscription to the lower price at period end, the winery no longer fits it,
 * and our record stayed on the higher plan. This moves Stripe back, so the
 * winery is billed for what it is served; the webhook that follows confirms
 * the plan our record already holds.
 */
export const createPlanRestorer =
  ({
    stripe,
    readState = (tenantId) => withTenant(tenantId, readBillingState),
  }: Pick<BillingDeps, 'stripe' | 'readState'>) =>
  async (tenantId: string, plan: PlanId): Promise<void> => {
    if (stripe === undefined) throw new ConflictError(BILLING_UNAVAILABLE);

    const subscriptionId = (await readState(tenantId))?.stripeSubscriptionId ?? null;

    /* A subscription since ended has nothing to put back. */
    if (subscriptionId === null) return;

    const live = await stripe.get(
      `/v1/subscriptions/${encodeURIComponent(subscriptionId)}`,
      {},
      subscription,
    );
    const [item] = live.items.data;
    const priceId = await currentPriceId(stripe, plan);

    /*
     * The downgrade's schedule is still attached through its second phase: it
     * is released first, so nothing it holds moves the price again.
     */
    if (live.schedule !== null) {
      await stripe.post(
        `/v1/subscription_schedules/${encodeURIComponent(live.schedule)}/release`,
        {},
        acknowledged,
      );
    }

    await stripe.post(
      `/v1/subscriptions/${encodeURIComponent(live.id)}`,
      { items: [{ id: item.id, price: priceId }], proration_behavior: 'none' },
      acknowledged,
    );
  };
