import { PLAN_IDS, type PlanId } from '../plans.js';

/**
 * The subscription state machine (P5-05, §2.5, §5.2b).
 *
 * **Pure, explicit, and the only thing that decides a winery's status from a
 * Stripe event.** This table decides whether the widget serves at all, so it is
 * written out and tested exhaustively (P5-06) rather than left to emerge from
 * webhook handlers. It knows nothing of HTTP, Stripe's payload shapes or the
 * database: an event arrives already read (`readBillingEvent`), the winery's
 * current state arrives already loaded, and the answer is either a change to
 * write or a reason to write nothing.
 *
 * Three guards come before any transition, and each closes a real hole:
 *
 * - **Order.** Stripe delivers out of order as a matter of course. An event
 *   created before the last one applied is ignored — otherwise a delayed
 *   `payment_failed` darkens a winery that has since paid, and with no grace
 *   period (§5.2b) that is a paying customer's widget gone dark at once.
 * - **Binding.** Only a completed Checkout binds a customer and a subscription
 *   to a winery. After that, an event for another customer or another
 *   subscription changes nothing (ADR 0029), and a second completed Checkout —
 *   two tabs, both paid — is caught rather than replacing the first.
 * - **Closure.** A `CANCELED` winery closed its account; nothing from Stripe
 *   reopens it.
 */

export const TENANT_STATUSES = [
  'PENDING_VERIFICATION',
  'TRIALING',
  'ACTIVE',
  'PAST_DUE',
  'DISABLED',
  'CANCELED',
] as const;

export type TenantStatus = (typeof TENANT_STATUSES)[number];

/** The statuses a widget is served in (§5.2b). `PAST_DUE` is not one of them: no grace. */
export const SERVED_STATUSES: ReadonlySet<TenantStatus> = new Set(['ACTIVE', 'TRIALING']);

/**
 * Whether a winery's widget is served right now (P5-05a, §1.3, §5.2b).
 *
 * **The one definition, read by every gate** — the config, the session mint
 * and every call that needs a session. `ACTIVE`, or `TRIALING` with the trial
 * still running: a trial ends when its date passes, without a job to move the
 * status, because a job that ran late would serve an expired trial for as long
 * as it was late. `PAST_DUE` is not served, on the first failure, with no
 * grace; nor is anything else.
 *
 * A `TRIALING` winery with no end date cannot exist (0061's CHECK), and is
 * refused here rather than served for ever should one ever be read.
 */
export const isServed = (
  winery: { readonly status: TenantStatus; readonly trialEndsAt: Date | null },
  now: Date = new Date(),
): boolean =>
  winery.status === 'ACTIVE' ||
  (winery.status === 'TRIALING' && winery.trialEndsAt !== null && winery.trialEndsAt > now);

/** A winery's billing state, as the database holds it. */
export interface BillingSnapshot {
  readonly status: TenantStatus;
  readonly plan: PlanId | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  /** When the last applied Stripe event was created; `null` before the first. */
  readonly lastEventAt: Date | null;
}

interface EventBase {
  /** The Stripe event's own `created`: the ordering guard's clock. */
  readonly occurredAt: Date;
  readonly customerId: string;
  readonly subscriptionId: string;
}

/** A Stripe event, read into what the machine needs and nothing more. */
export type BillingEvent =
  | (EventBase & {
      readonly kind: 'checkout_completed';
      /** From the session's metadata, which P5-02 writes; `undefined` if it is not ours. */
      readonly plan: PlanId | undefined;
      /** Paid now — card — or later, by a payment method that settles asynchronously. */
      readonly paid: boolean;
    })
  | (EventBase & {
      readonly kind: 'subscription_changed';
      /** Stripe's own status, as it spells it. */
      readonly stripeStatus: string;
      /** From the price's lookup key; `undefined` for a price that is not one of ours. */
      readonly plan: PlanId | undefined;
    })
  | (EventBase & { readonly kind: 'subscription_ended' })
  | (EventBase & { readonly kind: 'payment_failed' })
  | (EventBase & { readonly kind: 'payment_succeeded' });

/** What to write. Every field, so the write is one statement and never a partial one. */
export interface BillingChange {
  readonly status: TenantStatus;
  readonly plan: PlanId | null;
  readonly customerId: string | null;
  readonly subscriptionId: string | null;
  readonly lastEventAt: Date;
}

export type IgnoreReason =
  /** Created before the last event applied: out of order, and superseded. */
  | 'stale'
  /** For a customer that is not this winery's. */
  | 'customer_mismatch'
  /** A second paid Checkout for a winery that already has a subscription. */
  | 'second_subscription'
  /** For a subscription that is not the winery's current one — an ended one, say. */
  | 'other_subscription'
  /** Before any Checkout has bound a customer: only a Checkout may bind one. */
  | 'not_bound'
  /** A Checkout whose plan is not one of ours. */
  | 'unknown_plan'
  /** A subscription status the machine has no transition for. */
  | 'unrecognised_status'
  /** The winery closed its account. */
  | 'closed';

export type Transition =
  | { readonly outcome: 'apply'; readonly change: BillingChange }
  | { readonly outcome: 'ignore'; readonly reason: IgnoreReason };

const ignore = (reason: IgnoreReason): Transition => ({ outcome: 'ignore', reason });

const isPlan = (value: string | undefined): value is PlanId => PLAN_IDS.includes(value as PlanId);

/**
 * Stripe's subscription statuses, and what each means for service.
 *
 * `trialing` is served: we run no Stripe-side trials (ours is card-free and
 * lives in `tenants.trial_ends_at`), so one only exists because somebody set it
 * up in Stripe, and Stripe considers it a valid subscription. `unpaid` is past
 * due with the retries exhausted — still no service. `incomplete` is a first
 * payment in flight and changes nothing until it settles.
 */
const FROM_STRIPE: Readonly<Record<string, TenantStatus | 'ended' | 'unchanged'>> = {
  active: 'ACTIVE',
  trialing: 'ACTIVE',
  past_due: 'PAST_DUE',
  unpaid: 'PAST_DUE',
  paused: 'DISABLED',
  canceled: 'ended',
  incomplete_expired: 'ended',
  incomplete: 'unchanged',
};

export const transition = (current: BillingSnapshot, event: BillingEvent): Transition => {
  if (current.status === 'CANCELED') return ignore('closed');

  if (current.lastEventAt !== null && event.occurredAt < current.lastEventAt)
    return ignore('stale');

  if (current.customerId !== null && current.customerId !== event.customerId) {
    return ignore('customer_mismatch');
  }

  const base = {
    status: current.status,
    plan: current.plan,
    customerId: current.customerId,
    subscriptionId: current.subscriptionId,
    lastEventAt: event.occurredAt,
  };

  const apply = (change: Partial<BillingChange>): Transition => ({
    outcome: 'apply',
    change: { ...base, ...change },
  });

  if (event.kind === 'checkout_completed') {
    if (current.subscriptionId !== null && current.subscriptionId !== event.subscriptionId) {
      return ignore('second_subscription');
    }

    if (!isPlan(event.plan)) return ignore('unknown_plan');

    return apply({
      customerId: event.customerId,
      subscriptionId: event.subscriptionId,
      plan: event.plan,
      /* Unpaid is bound and waiting: `payment_succeeded` activates it. */
      ...(event.paid ? { status: 'ACTIVE' as const } : {}),
    });
  }

  if (current.customerId === null) return ignore('not_bound');
  if (current.subscriptionId !== event.subscriptionId) return ignore('other_subscription');

  switch (event.kind) {
    case 'subscription_changed': {
      const mapped = FROM_STRIPE[event.stripeStatus];

      if (mapped === undefined) return ignore('unrecognised_status');
      if (mapped === 'ended')
        return apply({ status: 'DISABLED', subscriptionId: null, plan: null });

      /* A price that is not ours keeps the plan on file rather than guessing one (P5-01). */
      const plan = isPlan(event.plan) ? event.plan : current.plan;

      return apply(mapped === 'unchanged' ? { plan } : { status: mapped, plan });
    }

    case 'subscription_ended':
      /*
       * The subscription is cleared so the winery can buy again (P5-02 refuses
       * a second while one is on file); the customer stays, so they are one
       * customer in Stripe when they do.
       */
      return apply({ status: 'DISABLED', subscriptionId: null, plan: null });

    case 'payment_failed':
      /*
       * **On the first failure, no grace** (§5.2b). From a served subscription
       * only: a winery already past due or switched off has nothing to lose,
       * and the event still moves the ordering clock.
       */
      return apply(current.status === 'ACTIVE' ? { status: 'PAST_DUE' } : {});

    case 'payment_succeeded':
      /* Stripe's retries restore service with no code and no human (§5.2b). */
      return apply({ status: 'ACTIVE' });
  }
};
