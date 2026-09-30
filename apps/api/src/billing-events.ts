import {
  BILLING_EVENT_TYPES,
  readBillingEvent,
  transition,
  type IgnoreReason,
} from '@catalogorosso/core';
import { insertAuditRow, readBillingSnapshot, writeBillingChange } from '@catalogorosso/db';

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

export const createBillingEffect =
  ({ livemode }: BillingEffectDeps): StripeEffect =>
  async (tx, delivery) => {
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
      logger.error(
        { kind: 'stripe_event_wrong_mode', type: delivery.type },
        `a ${read.livemode ? 'live' : 'test'}-mode event reached a stage that takes the other (§5.2b)`,
      );

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

    if ((await writeBillingChange(tx, decided.change)) === 'customer_taken') {
      logger.warn(
        { kind: 'stripe_event_ignored', type: 'customer_taken' },
        'a Stripe customer or subscription is already bound to another winery (§5.2b)',
      );

      return NOTHING;
    }

    if (decided.change.status !== current.status) {
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
          to: decided.change.status,
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
    const enteredPastDue = decided.change.status === 'PAST_DUE' && current.status !== 'PAST_DUE';

    return enteredPastDue ? { applied: true, notice: 'payment_failed' } : { applied: true };
  };
