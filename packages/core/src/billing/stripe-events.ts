import { z } from 'zod';

import { PLAN_IDS, planForLookupKey, TOP_UP, type PlanId } from '../plans.js';

import { STRIPE_PLAN_KEY, STRIPE_TENANT_KEY, STRIPE_TOP_UP_KEY } from './checkout.js';
import type { BillingEvent } from './state.js';

/**
 * Reading Stripe events (P5-04, P5-05).
 *
 * Signature-verified already (P5-03); what arrives here is Stripe's, and the
 * question is only what it says. Written against the pinned API version
 * (`STRIPE_API_VERSION`), which is also the version the webhook endpoint must
 * be created on — an endpoint on another version sends other shapes.
 */

/** The shape of a tenant id: `withTenant`'s rule, and nothing looser. */
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/iu;

const metadata = z.record(z.string(), z.unknown()).nullish();

/**
 * The three places an event can carry the winery P5-02 wrote into it.
 *
 * `client_reference_id` and `metadata` on a Checkout session; `metadata` on a
 * subscription; and, on an invoice, the metadata of the subscription it bills,
 * which Stripe moved to `parent.subscription_details` in 2025. Everything else
 * in the object is ignored here.
 */
const attributed = z.object({
  data: z.object({
    object: z.object({
      client_reference_id: z.string().nullish(),
      metadata,
      parent: z.object({ subscription_details: z.object({ metadata }).nullish() }).nullish(),
    }),
  }),
});

/**
 * The winery a verified Stripe event names, or `undefined` (ADR 0029).
 *
 * **The one place a tenant id is read from a request body**, and only because
 * we wrote it: P5-02 puts the session's own tenant into Stripe-signed data at
 * Checkout, and the browser never supplies it. It is read strictly —
 *
 * - under `tenant_id` and `client_reference_id` only, never a `tenantId` or any
 *   other spelling somebody could add;
 * - as a string in `withTenant`'s UUID shape, and nothing else;
 * - consistently: an event whose places disagree names nobody, because one of
 *   them is not ours.
 *
 * An event that names nobody changes nothing. The caller still binds the
 * winery it names to the customer on file before applying anything (P5-05).
 */
export const tenantOfStripeEvent = (payload: unknown): string | undefined => {
  const parsed = attributed.safeParse(payload);

  if (!parsed.success) return undefined;

  const { client_reference_id, metadata: own, parent } = parsed.data.data.object;
  const named = [
    client_reference_id,
    own?.[STRIPE_TENANT_KEY],
    parent?.subscription_details?.metadata?.[STRIPE_TENANT_KEY],
  ].filter((value) => value !== undefined && value !== null);

  const [first] = named;

  if (typeof first !== 'string' || !UUID.test(first)) return undefined;
  if (named.some((value) => value !== first)) return undefined;

  return first;
};

/* ------------------------------------------------------------------ events */

/** Every event the machine acts on, and the event it becomes. Anything else is not read. */
export const BILLING_EVENT_TYPES = [
  'checkout.session.completed',
  'checkout.session.async_payment_succeeded',
  'customer.subscription.created',
  'customer.subscription.updated',
  'customer.subscription.deleted',
  'invoice.payment_failed',
  'invoice.paid',
  'invoice.payment_succeeded',
] as const;

const envelope = z.object({
  type: z.string(),
  created: z.number().int().nonnegative(),
  livemode: z.boolean(),
  data: z.object({ object: z.unknown() }),
});

/** Ids arrive as strings in a webhook; an expanded object is not something we asked for. */
const id = z.string().min(1);

const session = z.object({
  mode: z.string(),
  customer: id,
  subscription: id,
  payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
  metadata: z.record(z.string(), z.string()).nullish(),
});

const subscription = z.object({
  id,
  customer: id,
  status: z.string(),
  items: z.object({
    data: z.array(z.object({ price: z.object({ lookup_key: z.string().nullish() }) })),
  }),
});

/**
 * An invoice's subscription, where the pinned API version carries it
 * (`parent.subscription_details`), or where older versions did.
 */
const invoice = z.object({
  customer: id,
  subscription: id.nullish(),
  parent: z.object({ subscription_details: z.object({ subscription: id }).nullish() }).nullish(),
});

export interface ReadBillingEvent {
  readonly event: BillingEvent;
  /** Test mode or live: the effect refuses the wrong one for its stage (§5.2b). */
  readonly livemode: boolean;
}

/**
 * A verified Stripe event, as the state machine reads it — or `undefined` for
 * a type it does not act on, a Checkout that is not a subscription's (P5-11a's
 * top-ups are paid in `payment` mode), or a shape it cannot read.
 *
 * `undefined` is not an error: the effect acknowledges it and changes nothing.
 * A shape it cannot read for a type it *does* act on is worth an alarm, and
 * the effect logs those apart.
 */
export const readBillingEvent = (payload: unknown): ReadBillingEvent | undefined => {
  const outer = envelope.safeParse(payload);

  if (!outer.success) return undefined;

  const { type, created, livemode, data } = outer.data;
  const occurredAt = new Date(created * 1000);
  const read = (event: BillingEvent): ReadBillingEvent => ({ event, livemode });

  switch (type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const parsed = session.safeParse(data.object);

      if (!parsed.success || parsed.data.mode !== 'subscription') return undefined;

      const { customer, subscription: subscriptionId, payment_status, metadata } = parsed.data;
      const plan = metadata?.[STRIPE_PLAN_KEY];

      return read({
        kind: 'checkout_completed',
        occurredAt,
        customerId: customer,
        subscriptionId,
        plan: PLAN_IDS.includes(plan as PlanId) ? (plan as PlanId) : undefined,
        paid: payment_status !== 'unpaid',
      });
    }

    case 'customer.subscription.created':
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const parsed = subscription.safeParse(data.object);

      if (!parsed.success) return undefined;

      const { id: subscriptionId, customer, status, items } = parsed.data;

      if (type === 'customer.subscription.deleted') {
        return read({
          kind: 'subscription_ended',
          occurredAt,
          customerId: customer,
          subscriptionId,
        });
      }

      return read({
        kind: 'subscription_changed',
        occurredAt,
        customerId: customer,
        subscriptionId,
        stripeStatus: status,
        plan: planForLookupKey(items.data[0]?.price.lookup_key),
      });
    }

    case 'invoice.payment_failed':
    case 'invoice.paid':
    case 'invoice.payment_succeeded': {
      const parsed = invoice.safeParse(data.object);

      if (!parsed.success) return undefined;

      const subscriptionId =
        parsed.data.parent?.subscription_details?.subscription ?? parsed.data.subscription;

      /* An invoice for no subscription — a one-off — is not the machine's. */
      if (subscriptionId === undefined || subscriptionId === null) return undefined;

      return read({
        kind: type === 'invoice.payment_failed' ? 'payment_failed' : 'payment_succeeded',
        occurredAt,
        customerId: parsed.data.customer,
        subscriptionId,
      });
    }

    default:
      return undefined;
  }
};

/* ------------------------------------------------------------------ top-ups */

const topUpSession = z.object({
  mode: z.literal('payment'),
  customer: id,
  payment_intent: id,
  payment_status: z.enum(['paid', 'unpaid', 'no_payment_required']),
  amount_total: z.number().int().nonnegative(),
  currency: z.string().min(1),
  metadata: z.record(z.string(), z.string()).nullish(),
});

/** A top-up's Checkout, as the webhook credits it (P5-11a). */
export interface TopUpPayment {
  readonly customerId: string;
  /** One payment is one credit: the ledger's unique key. */
  readonly paymentIntentId: string;
  /**
   * Whether the money has arrived. A delayed method completes `unpaid` and
   * sends `checkout.session.async_payment_succeeded` once it clears; only a
   * paid session credits anything. `no_payment_required` is not paid: a coupon
   * clicked into the Dashboard does not hand out free messages.
   */
  readonly paid: boolean;
  /** What was paid, in minor units, for the charge the invoicing bridge reads (P5-03a). */
  readonly amountCents: number;
  /** Lowercase, as Stripe writes it. */
  readonly currency: string;
  /** When Stripe reported it: the month the messages count towards. */
  readonly occurredAt: Date;
  readonly livemode: boolean;
}

/**
 * A verified Stripe event, read as a top-up payment — or `undefined` for
 * anything else, a plan's Checkout included (P5-11a).
 *
 * **A top-up is told apart by what we wrote**: `mode: 'payment'` and our
 * `top_up` metadata naming the one top-up `plans.ts` sells. A payment-mode
 * Checkout somebody made in the Dashboard carries neither, and credits
 * nothing.
 */
export const readTopUpEvent = (payload: unknown): TopUpPayment | undefined => {
  const outer = envelope.safeParse(payload);

  if (!outer.success) return undefined;

  const { type, created, livemode, data } = outer.data;

  if (
    type !== 'checkout.session.completed' &&
    type !== 'checkout.session.async_payment_succeeded'
  ) {
    return undefined;
  }

  const parsed = topUpSession.safeParse(data.object);

  if (!parsed.success || parsed.data.metadata?.[STRIPE_TOP_UP_KEY] !== TOP_UP.id) return undefined;

  return {
    customerId: parsed.data.customer,
    paymentIntentId: parsed.data.payment_intent,
    paid: parsed.data.payment_status === 'paid',
    amountCents: parsed.data.amount_total,
    currency: parsed.data.currency.toLowerCase(),
    occurredAt: new Date(created * 1000),
    livemode,
  };
};
