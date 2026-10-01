import {
  BILLING_PATH,
  LOCALES,
  periodEnd,
  periodOf,
  PLAN_IDS,
  PLANS,
  thresholdReached,
  TOP_UP,
  type Locale,
  type PlanId,
  type QuotaNoticeProps,
  type QuotaThreshold,
  type SendEmail,
} from '@catalogorosso/core';
import {
  claimQuotaNotice,
  readOwnerRecipients,
  withTenant,
  type OwnerRecipients,
} from '@catalogorosso/db';

/**
 * Telling the owners their month is running out, and when it has (P5-12,
 * §2.3): at four fifths of the allowance, and at all of it.
 *
 * **Once per winery, per month, per threshold**: the notice is claimed in
 * `notification_events` before it is sent, and the key is the idempotency — two
 * messages crossing 80% together tell the owners once. Claimed before the send,
 * so the failure mode is a lost email (which `sendEmail` retries and alarms
 * on), never a second one.
 *
 * **Owners only** (§2.3): billing is an owner's to act on, and an editor told
 * by email would have nothing to click. Editors are told by the dashboard's
 * banner instead, which asks them to tell an owner.
 */

export type QuotaNotifier = (
  tenant: { readonly tenantId: string; readonly plan: PlanId | null },
  used: number,
  allowance: number,
) => Promise<void>;

export interface QuotaNotifierDeps {
  readonly sendEmailFor: (tenantId: string) => SendEmail;
  /** The dashboard, whose Fatturazione screen holds both ways out (P5-11a, P5-09). */
  readonly dashboardOrigin: string;
  readonly recipientsOf?: ((tenantId: string) => Promise<OwnerRecipients | undefined>) | undefined;
  /** `claimQuotaNotice` in the winery's scope: `true` for the one caller who sends. */
  readonly claim?:
    ((tenantId: string, period: string, threshold: QuotaThreshold) => Promise<boolean>) | undefined;
  readonly now?: (() => Date) | undefined;
}

const localeOf = (value: string): Locale =>
  (LOCALES as readonly string[]).includes(value) ? (value as Locale) : 'it';

/** `€15`: whole euros, as the plan cards and the price list say them. */
const euros = (cents: number): string =>
  `€${String(cents % 100 === 0 ? cents / 100 : (cents / 100).toFixed(2))}`;

/** The day the quota resets, as the reader writes dates. */
const resetDay = (at: Date, locale: Locale): string =>
  new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
    timeZone: 'UTC',
  }).format(periodEnd(at));

/**
 * The plan a winery would move up to: the next on the ladder, or the first for
 * a winery with none yet. `undefined` on the top plan.
 */
const nextPlan = (plan: PlanId | null): PlanId | undefined =>
  plan === null ? PLAN_IDS[0] : PLAN_IDS[PLAN_IDS.indexOf(plan) + 1];

export const createQuotaNotifier = ({
  sendEmailFor,
  dashboardOrigin,
  recipientsOf = (tenantId) => withTenant(tenantId, readOwnerRecipients),
  claim = (tenantId, period, threshold) =>
    withTenant(tenantId, (tx) => claimQuotaNotice(tx, period, threshold)),
  now = () => new Date(),
}: QuotaNotifierDeps): QuotaNotifier => {
  return async (tenant, used, allowance) => {
    const threshold = thresholdReached(used, allowance);

    if (threshold === undefined) return;

    const at = now();

    if (!(await claim(tenant.tenantId, periodOf(at), threshold))) return;

    const recipients = await recipientsOf(tenant.tenantId);

    /* The winery is gone: nobody to tell. */
    if (recipients === undefined) return;

    const locale = localeOf(recipients.locale);
    const sendEmail = sendEmailFor(tenant.tenantId);
    const billingUrl = `${dashboardOrigin}${BILLING_PATH}`;
    const upgradeTo = nextPlan(tenant.plan);

    /*
     * **Both ways out, where they exist.** A top-up is for a winery on a plan
     * (P5-11a), so a trial is offered a plan instead; the top plan has nothing
     * above it, so it is offered the top-up alone. The links land on the
     * Fatturazione screen, at the button — buying needs a signed-in owner.
     */
    const props: QuotaNoticeProps = {
      tenantName: recipients.tenantName,
      periodEndsOn: resetDay(at, locale),
      topUp:
        tenant.plan === null
          ? null
          : {
              url: `${billingUrl}#ricarica`,
              price: euros(TOP_UP.amountCents),
              messages: TOP_UP.messages,
            },
      upgrade:
        upgradeTo === undefined
          ? null
          : {
              plan: PLANS[upgradeTo].name,
              price: euros(PLANS[upgradeTo].amountCents),
              url: `${billingUrl}#piano`,
            },
    };

    for (const owner of recipients.owners) {
      await (threshold === 100
        ? sendEmail({ to: owner, template: 'quota-exhausted', props, locale })
        : sendEmail({
            to: owner,
            template: 'quota-warning',
            props: { ...props, usedPercent: threshold },
            locale,
          }));
    }
  };
};
