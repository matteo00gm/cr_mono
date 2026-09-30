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
