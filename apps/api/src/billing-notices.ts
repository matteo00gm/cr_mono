import { BILLING_PATH, LOCALES, type Locale, type SendEmail } from '@catalogorosso/core';
import { readOwnerRecipients, withTenant, type OwnerRecipients } from '@catalogorosso/db';

/**
 * Telling a winery's owners what a billing event did (P5-05a, §5.2b).
 *
 * **Sent after the event's transaction has committed**, never inside it: a
 * message about a change that then rolled back is a message people act on.
 * The port calls this once the claim is written, so a notice is sent at most
 * once per event — a redelivery is a duplicate and sends nothing.
 *
 * **Best effort, with the seam's retries.** `sendEmail` retries with backoff and
 * raises P0-64's `email_send_failed` alarm when it gives up; a notice that is
 * lost then is a lost email, not a lost payment, and the dashboard's banner
 * (P5-12) says the same thing to the owner the moment they look.
 */

/** What an event can leave an owner to be told. */
export type BillingNotice = 'payment_failed';

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
}

/** The template each notice is sent as. A notice with no template is a compile error. */
const TEMPLATE_FOR: Readonly<Record<BillingNotice, 'payment-failed'>> = {
  payment_failed: 'payment-failed',
};

const localeOf = (value: string): Locale =>
  (LOCALES as readonly string[]).includes(value) ? (value as Locale) : 'it';

export const createBillingNotifier = ({
  sendEmailFor,
  dashboardOrigin,
  recipientsOf = (tenantId) => withTenant(tenantId, readOwnerRecipients),
}: BillingNotifierDeps): BillingNotifier => {
  return async (tenantId, notice) => {
    const recipients = await recipientsOf(tenantId);

    /* The winery is gone: nobody to tell, and nothing to tell them. */
    if (recipients === undefined) return;

    const locale = localeOf(recipients.locale);
    const sendEmail = sendEmailFor(tenantId);

    /*
     * **Every owner, and only owners** (§5.2b): billing is an owner's business,
     * and an editor could not act on it. One at a time: a winery has one or
     * two, and the seam's staggered sends are what keep the daily cap (P0-64).
     */
    for (const owner of recipients.owners) {
      await sendEmail({
        to: owner,
        template: TEMPLATE_FOR[notice],
        props: {
          tenantName: recipients.tenantName,
          billingUrl: `${dashboardOrigin}${BILLING_PATH}`,
        },
        locale,
      });
    }
  };
};
