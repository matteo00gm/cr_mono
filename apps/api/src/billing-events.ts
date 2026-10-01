import {
  BILLING_EVENT_TYPES,
  downgradeBlockers,
  downgradeRefusal,
  isDowngrade,
  periodOf,
  readBillingEvent,
  readTopUpEvent,
  TOP_UP,
  transition,
  type BillingChange,
  type IgnoreReason,
  type TopUpPayment,
} from '@catalogorosso/core';
import {
  insertAuditRow,
  readBillingSnapshot,
  readPlanFootprint,
  recordTopUp,
  writeBillingChange,
  type DbTransaction,
} from '@catalogorosso/db';

import type { BillingNotice } from './billing-notices.js';
import { logger } from './middleware/logger.js';
import type { StripeEffect } from './stripe-events.js';

/**
 * What a Stripe event does to a winery (P5-05): the state machine, applied on
 * the transaction that claimed the event (P5-04), under the winery it names.
 *
 * **Every "no" is logged by kind, and none is an error.** A verified event we
 * do not act on is answered 200 and claimed: it has been handled, and Stripe
 * retrying it would change nothing. The kinds are what an alarm watches —
 * `stripe_event_unreadable` and `stripe_event_wrong_mode` are ours to fix, and
 * a `customer_mismatch` or `second_subscription` is a person to call.
 */

export interface BillingEffectDeps {
  /**
   * Whether this stage takes live-mode events (§5.2b). Production does and
   * nothing else does, which closes the misconfiguration where a test-mode
   * secret ends up on the production endpoint and test payments activate real
   * wineries — and its mirror, live money arriving at a staging stage.
   */
  readonly livemode: boolean;
}

/**
 * How loudly each refusal is said.
 *
 * `stale` and `not_bound` are Stripe's ordinary out-of-order delivery. The rest
 * are either somebody working in the Stripe Dashboard or somebody trying
 * something, and are said as such.
 */
const LOUD: ReadonlySet<IgnoreReason> = new Set([
  'customer_mismatch',
  'second_subscription',
  'unknown_plan',
  'unrecognised_status',
]);

const ACTED_ON: ReadonlySet<string> = new Set(BILLING_EVENT_TYPES);

/** An event that changed nothing and leaves nobody to tell. */
const NOTHING = { applied: false } as const;

const wrongMode = (type: string, eventLivemode: boolean) => {
  logger.error(
    { kind: 'stripe_event_wrong_mode', type },
    `a ${eventLivemode ? 'live' : 'test'}-mode event reached a stage that takes the other (§5.2b)`,
  );
};

/**
 * Credits a paid top-up to the month it was paid in (P5-11a), on the claim's
 * own transaction — so the credit and "this event was handled" are one write.
 *
 * **Bound to the customer on file**, as every billing event is (P5-05): a
 * payment from a customer that is not this winery's credits nothing. **Once per
 * payment**: the ledger's unique payment intent turns a second event about the
 * same money into a no-op. Credited whatever the winery's status, because the
 * money was taken; a paused widget uses it once it is paid up.
 */
const creditTopUp = async (
  tx: DbTransaction,
  tenantId: string,
  type: string,
  payment: TopUpPayment,
  livemode: boolean,
): Promise<{ readonly applied: boolean }> => {
  if (payment.livemode !== livemode) {
    wrongMode(type, payment.livemode);

    return NOTHING;
  }

  /* A delayed method completes unpaid; its async success is the one that credits. */
  if (!payment.paid) return NOTHING;

  const current = await readBillingSnapshot(tx);

  if (current === undefined) return NOTHING;

  if (current.customerId !== payment.customerId) {
    logger.warn(
      { kind: 'stripe_event_ignored', type: 'customer_mismatch' },
      `a ${type} top-up was paid by a customer that is not this winery's (P5-11a)`,
    );

    return NOTHING;
  }

  const period = periodOf(payment.occurredAt);
  const credited = await recordTopUp(tx, {
    period,
    messages: TOP_UP.messages,
    paymentIntentId: payment.paymentIntentId,
  });

  if (credited === 'duplicate') return NOTHING;

  await insertAuditRow(tx, {
    tenantId,
    actorUserId: undefined,
    action: 'billing.top_up_credited',
    target: `tenant:${tenantId}`,
    metadata: JSON.stringify({ messages: TOP_UP.messages, period, event: type }),
    ip: undefined,
    userAgent: undefined,
  });

  return { applied: true };
};

export const createBillingEffect =
  ({ livemode }: BillingEffectDeps): StripeEffect =>
  async (tx, delivery) => {
    /*
     * A top-up first: its Checkout is a payment, not a subscription, and the
     * machine below has nothing to say about it (P5-11a).
     */
    const topUp = readTopUpEvent(delivery.payload);

    if (topUp !== undefined) {
      return creditTopUp(tx, delivery.tenantId, delivery.type, topUp, livemode);
    }

    const read = readBillingEvent(delivery.payload);

    if (read === undefined) {
      /*
       * A type the machine does not act on is expected: the endpoint may be
       * sent more than it needs. One it *does* act on, in a shape it cannot
       * read, is Stripe changing something under us.
       */
      if (ACTED_ON.has(delivery.type)) {
        logger.warn(
          { kind: 'stripe_event_unreadable', type: delivery.type },
          'a billing event of a type we act on could not be read (P5-05)',
        );
      }

      return NOTHING;
    }

    if (read.livemode !== livemode) {
      wrongMode(delivery.type, read.livemode);

      return NOTHING;
    }

    const current = await readBillingSnapshot(tx);

    /* The winery it names is gone: nothing to change, and the event is handled. */
    if (current === undefined) return NOTHING;

    const decided = transition(current, read.event);

    if (decided.outcome === 'ignore') {
      const say = LOUD.has(decided.reason) ? logger.warn.bind(logger) : logger.info.bind(logger);

      say(
        { kind: 'stripe_event_ignored', type: decided.reason },
        `a ${delivery.type} event changed nothing (P5-05)`,
      );

      return NOTHING;
    }

    /*
     * **A downgrade is re-checked as it applies** (P5-10). It was allowed when
     * it was scheduled, but a winery can grow in the month to its period end,
     * and moving it now to a plan it does not fit would break a live widget.
     * So our record keeps the plan it has, and the notice asks the port — after
     * this commits — to put Stripe's price back and tell the owners what to
     * reduce. Read on the claim's own transaction: the count and the decision
     * are one snapshot.
     */
    let change: BillingChange = decided.change;
    let deferred: BillingNotice | undefined;

    if (current.plan !== null && change.plan !== null && isDowngrade(current.plan, change.plan)) {
      const blockers = downgradeBlockers(await readPlanFootprint(tx), change.plan);

      if (blockers.length > 0) {
        logger.warn(
          { kind: 'stripe_downgrade_deferred', type: change.plan },
          'a downgrade reached its period end with the winery over the lower plan; kept (P5-10)',
        );

        deferred = {
          kind: 'downgrade_deferred',
          kept: current.plan,
          wanted: change.plan,
          reason: downgradeRefusal(change.plan, blockers),
        };
        change = { ...change, plan: current.plan };
      }
    }

    if ((await writeBillingChange(tx, change)) === 'customer_taken') {
      logger.warn(
        { kind: 'stripe_event_ignored', type: 'customer_taken' },
        'a Stripe customer or subscription is already bound to another winery (§5.2b)',
      );

      return NOTHING;
    }

    if (change.status !== current.status) {
      /*
       * On the claim's own transaction (P0-53), and with no actor: Stripe did
       * this, not a member of the winery.
       */
      await insertAuditRow(tx, {
        tenantId: delivery.tenantId,
        actorUserId: undefined,
        action: 'billing.status_changed',
        target: `tenant:${delivery.tenantId}`,
        metadata: JSON.stringify({
          from: current.status,
          to: change.status,
          event: delivery.type,
        }),
        ip: undefined,
        userAgent: undefined,
      });
    }

    /*
     * **Entering `PAST_DUE` is the one move an owner must hear about at once**
     * (§5.2b): their widget went dark on this event. Entering, not being — a
     * second failure while already past due tells nobody twice.
     */
    const enteredPastDue = change.status === 'PAST_DUE' && current.status !== 'PAST_DUE';

    if (enteredPastDue) return { applied: true, notice: { kind: 'payment_failed' } };

    return deferred === undefined ? { applied: true } : { applied: true, notice: deferred };
  };
