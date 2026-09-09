import { suppressionsFor, type EventOutcome } from '@catalogorosso/core';
import { suppressAddress, withWebhookEvent } from '@catalogorosso/db';

/**
 * The delivery-event port and its database-backed implementation (P0-64b).
 *
 * The composition root's job for the same reason `members.ts` is: this is the
 * one place that knows both what an event means and where the consequence is
 * stored. `packages/core` reads the payload and has no database;
 * `packages/db` writes the rows and has never heard of Resend.
 */

export interface DeliveryEvent {
  /** The provider's id for this delivery — `svix-id`. Never the payload's. */
  readonly eventId: string;
  /** Already signature-verified. Shape unknown until core reads it. */
  readonly payload: unknown;
}

export interface DeliveryResult extends EventOutcome {
  /**
   * True when this exact delivery had already been applied.
   *
   * Reported rather than hidden because a redelivery is normal and a *flood* of
   * them is not: providers redeliver when we answered slowly or with a 5xx, so
   * a rising duplicate count is the signal that this endpoint is timing out.
   */
  readonly duplicate: boolean;
}

export interface WebhooksPort {
  record(event: DeliveryEvent): Promise<DeliveryResult>;
}

/**
 * The port with nothing behind it.
 *
 * Throws rather than answering plausibly, the same shape as
 * `unconfiguredMembers`: an unwired webhook endpoint that returned 200 would
 * tell Resend every bounce was recorded while the suppression list stayed
 * empty, which is E7's failure — silent, and indistinguishable from a domain
 * with no bounces at all.
 */
export class WebhooksPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No webhooks port was supplied to createApp, so delivery events cannot be recorded. ' +
        'This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'WebhooksPortNotConfiguredError';
  }
}

export const unconfiguredWebhooks: WebhooksPort = {
  record: () => Promise.reject(new WebhooksPortNotConfiguredError()),
};

/* -------------------------------------------------------------------------- */

export const createWebhooksPort = (): WebhooksPort => ({
  async record({ eventId, payload }) {
    /*
     * Read before the transaction opens, deliberately. `suppressionsFor` throws
     * on a payload it cannot read at all, and doing that inside a transaction
     * would claim the event id on the way to the rollback — leaving an event
     * marked processed that was never applied, which is the one state the
     * ledger must not reach.
     */
    const outcome = suppressionsFor(payload);

    const run = await withWebhookEvent({ provider: 'resend', eventId }, async (tx) => {
      /*
       * Sequential rather than `Promise.all`: these share one transaction, and
       * concurrent statements on a single connection serialise anyway. The
       * realistic count is one — we mail one address at a time — so the loop is
       * for correctness on the day a provider sends a multi-recipient event,
       * not for throughput.
       */
      for (const suppression of outcome.suppressions) {
        await suppressAddress(tx, suppression);
      }
    });

    return { ...outcome, duplicate: !run.claimed };
  },
});
