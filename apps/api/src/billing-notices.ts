import {
  BILLING_PATH,
  LOCALES,
  PLANS,
  type Locale,
  type PlanId,
  type SendEmail,
} from '@catalogorosso/core';
import { readOwnerRecipients, withTenant, type OwnerRecipients } from '@catalogorosso/db';

import { logger } from './middleware/logger.js';

/**
 * What an applied billing event leaves to be done once it has committed
 * (P5-05a, P5-10, §5.2b): telling the owners, and — for a downgrade refused as
 * it applied — putting Stripe's price back.
 *
 * **After the event's transaction has committed**, never inside it: a message
 * about a change that then rolled back is a message people act on, and a Stripe
 * call inside the claim would hold the winery's row on a network round trip.
 * The port calls this once the claim is written, so it runs at most once per
 * event — a redelivery is a duplicate and does nothing.
 *
 * **Best effort, with the seam's retries.** `sendEmail` retries with backoff and
 * raises P0-64's `email_send_failed` alarm when it gives up; a notice that is
 * lost then is a lost email, not a lost payment, and the dashboard's banner
 * (P5-12) says the same thing to the owner the moment they look. A restore
 * that fails is logged for the operator to reconcile by hand.
 */

/** What an event can leave to be done once it has committed. */
export type BillingNotice =
  /** The widget went dark on a failed payment (P5-05a). */
  | { readonly kind: 'payment_failed' }
  /**
   * A downgrade reached its period end with the winery over the lower plan's
   * caps (P5-10): our record kept the plan it had, and Stripe is moved back to
   * that plan's price.
   */
  | {
      readonly kind: 'downgrade_deferred';
      readonly kept: PlanId;
      readonly wanted: PlanId;
      /** What to reduce and by how much, already worded (`downgradeRefusal`). */
      readonly reason: string;
    };

export type BillingNotifier = (tenantId: string, notice: BillingNotice) => Promise<void>;

export interface BillingNotifierDeps {
  /**
   * The seam, for one winery: its suppression list is read under that
   * winery's scope, as the claim sweep reads it (P4-18b).
   */
  readonly sendEmailFor: (tenantId: string) => SendEmail;
  /** The dashboard, whose Fatturazione screen holds the Stripe portal link (P5-08). */
  readonly dashboardOrigin: string;
  readonly recipientsOf?: ((tenantId: string) => Promise<OwnerRecipients | undefined>) | undefined;
  /**
   * Puts the winery's Stripe price back on a plan (`createPlanRestorer`).
   * Absent where there is no Stripe key — and then nothing was billed either.
   */
  readonly restorePlan?: ((tenantId: string, plan: PlanId) => Promise<void>) | undefined;
}

const localeOf = (value: string): Locale =>
  (LOCALES as readonly string[]).includes(value) ? (value as Locale) : 'it';

export const createBillingNotifier = ({
  sendEmailFor,
  dashboardOrigin,
  recipientsOf = (tenantId) => withTenant(tenantId, readOwnerRecipients),
  restorePlan,
}: BillingNotifierDeps): BillingNotifier => {
  return async (tenantId, notice) => {
    if (notice.kind === 'downgrade_deferred' && restorePlan !== undefined) {
      try {
        await restorePlan(tenantId, notice.kept);
      } catch (error) {
        /*
         * Our record holds the higher plan and Stripe bills the lower: the
         * winery is served more than it pays for until somebody moves Stripe.
         * Said loudly — and the owners are still told below.
         */
        logger.error(
          { kind: 'billing_restore_failed', type: notice.kept, err: error },
          'a refused downgrade could not be put back in Stripe; reconcile the price by hand (P5-10)',
        );
      }
    }

    const recipients = await recipientsOf(tenantId);

    /* The winery is gone: nobody to tell, and nothing to tell them. */
    if (recipients === undefined) return;

    const locale = localeOf(recipients.locale);
    const sendEmail = sendEmailFor(tenantId);
    const billingUrl = `${dashboardOrigin}${BILLING_PATH}`;

    /*
     * **Every owner, and only owners** (§5.2b): billing is an owner's business,
     * and an editor could not act on it. One at a time: a winery has one or
     * two, and the seam's staggered sends are what keep the daily cap (P0-64).
     */
    for (const owner of recipients.owners) {
      await (notice.kind === 'payment_failed'
        ? sendEmail({
            to: owner,
            template: 'payment-failed',
            props: { tenantName: recipients.tenantName, billingUrl },
            locale,
          })
        : sendEmail({
            to: owner,
            template: 'downgrade-deferred',
            props: {
              tenantName: recipients.tenantName,
              keptPlan: PLANS[notice.kept].name,
              wantedPlan: PLANS[notice.wanted].name,
              reason: notice.reason,
              billingUrl,
            },
            locale,
          }));
    }
  };
};
