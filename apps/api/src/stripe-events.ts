import { tenantOfStripeEvent } from '@catalogorosso/core';
import { withTenantWebhookEvent, type DbTransaction } from '@catalogorosso/db';

import type { BillingNotice, BillingNotifier } from './billing-notices.js';
import { logger } from './middleware/logger.js';

/**
 * The Stripe event port (P5-03).
 *
 * What the webhook route hands a verified delivery to. The route knows
 * signatures and HTTP; this knows what an event means for a winery and where
 * that is written — P5-04 claims it exactly once, P5-05 moves the winery's
 * status. The composition root's job, for `webhooks.ts`'s reasons.
 */

export interface StripeDelivery {
  /**
   * Stripe's event id, `evt_…`, read from the body.
   *
   * Safe as the idempotency key because the body is inside the signature —
   * unlike an id in an unsigned header, which a replayer could change.
   */
  readonly eventId: string;
  /** `checkout.session.completed`, `invoice.payment_failed`, … */
  readonly type: string;
  /** Already signature-verified. Shape unknown until the event reader reads it. */
  readonly payload: unknown;
}

export interface StripeDeliveryResult {
  /** This exact event had already been applied: a redelivery, answered 200. */
  readonly duplicate: boolean;
  /** Whether it changed anything; most event types we receive change nothing. */
  readonly applied: boolean;
}

export interface StripeEventsPort {
  readonly record: (delivery: StripeDelivery) => Promise<StripeDeliveryResult>;
}

/**
 * The port with nothing behind it.
 *
 * **A 500, and that is the safe answer for an unwired billing endpoint.** A 200
 * would tell Stripe the event was handled, and it would never be sent again —
 * a payment that failed would stay unapplied and the widget would keep
 * serving. A 500 is retried for three days, so every event arrives again once
 * the port is wired.
 */
export class StripeEventsPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No Stripe events port was supplied to createApp, so a verified billing event cannot be ' +
        'applied. This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'StripeEventsPortNotConfiguredError';
  }
}

export const unconfiguredStripeEvents: StripeEventsPort = {
  record: () => Promise.reject(new StripeEventsPortNotConfiguredError()),
};

/* -------------------------------------------------------------------------- */

/** A delivery with the winery it names, as the effect receives it. */
export interface AttributedDelivery extends StripeDelivery {
  readonly tenantId: string;
}

/** What an effect did: whether it changed anything, and what an owner must be told. */
export interface StripeOutcome {
  readonly applied: boolean;
  /** Sent after the claim commits, and so at most once per event (P5-05a). */
  readonly notice?: BillingNotice | undefined;
}

/**
 * What an event does to a winery, on the transaction that claimed it.
 *
 * P5-05's state machine is the one in production; it runs under the named
 * winery's tenant policy, so it reaches that winery's row and no other.
 */
export type StripeEffect = (
  tx: DbTransaction,
  delivery: AttributedDelivery,
) => Promise<StripeOutcome>;

export interface StripeEventsDeps {
  /**
   * **Required, so the port cannot exist without an effect.** A port that
   * claimed events and did nothing would mark each one processed for ever —
   * the one state the ledger must never reach — and Stripe would never send
   * it again.
   */
  readonly apply: StripeEffect;
  /** `withTenantWebhookEvent`; injected by the unit tests. */
  readonly claim?: typeof withTenantWebhookEvent | undefined;
  /**
   * Tells the owners what an applied event left them to be told (P5-05a).
   * Called after the claim has committed; a failure is logged and dropped,
   * because the event is applied and Stripe must not be asked to send it again.
   */
  readonly notify?: BillingNotifier | undefined;
}

/**
 * Exactly once per event, under the winery it names (P5-04, ADR 0029).
 *
 * The event id is Stripe's, from inside the signed body. The winery is the one
 * P5-02 wrote into the event, read strictly by `tenantOfStripeEvent`; an event
 * that names nobody is acknowledged and logged, and never claimed — there is
 * no winery transaction to claim it in, and nothing it could change.
 */
export const createStripeEventsPort = ({
  apply,
  claim = withTenantWebhookEvent,
  notify,
}: StripeEventsDeps): StripeEventsPort => ({
  async record(delivery) {
    const tenantId = tenantOfStripeEvent(delivery.payload);

    if (tenantId === undefined) {
      /*
       * Not ours, or not a shape we know: an event from a subscription made
       * in Stripe's Dashboard, a type the endpoint should not be sent, or
       * Stripe moving where it carries metadata. The type is safe to log; it
       * is Stripe's vocabulary, never a customer's.
       */
      logger.warn(
        { kind: 'stripe_event_unattributed', type: delivery.type },
        'a verified Stripe event names no winery of ours, so it changes nothing (ADR 0029)',
      );

      return { duplicate: false, applied: false };
    }

    const run = await claim(tenantId, { provider: 'stripe', eventId: delivery.eventId }, (tx) =>
      apply(tx, { ...delivery, tenantId }),
    );

    if (!run.claimed) return { duplicate: true, applied: false };

    const { applied, notice } = run.result;

    if (notice !== undefined && notify !== undefined) {
      try {
        await notify(tenantId, notice);
      } catch (error) {
        /*
         * The event is applied and claimed; answering 500 now would have
         * Stripe resend it, and the redelivery would be a duplicate that
         * tells nobody anything. The seam has already retried and alarmed.
         */
        logger.error(
          { kind: 'billing_notice_unsent', type: notice, err: error },
          'an owner could not be told what a billing event did (P5-05a)',
        );
      }
    }

    return { duplicate: false, applied };
  },
});
