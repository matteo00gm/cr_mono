import process from 'node:process';

import {
  capFor,
  chooseTransport,
  CLAIM_NOTICE_HOURS,
  createSendEmail,
  LOCALES,
  logTransport,
  resendTransport,
  type Locale,
  type SendEmail,
  type TemplateName,
  type TemplateProps,
} from '@catalogorosso/core';
import {
  isSuppressed,
  markClaimNotified,
  readOwnerRecipients,
  readClaimWork,
  readTenantPlan,
  settleDomainClaim,
  withTenant,
  type OwnerRecipients,
  type ClaimWork,
} from '@catalogorosso/db';

/**
 * The claim sweep (P4-18b): tells both wineries what a domain claim did, and
 * moves a paying holder's origin once its notice has been told and has run out.
 *
 * **The order is the safeguard.** A notice protects a paying holder only once
 * the holder has been told, so the notice mail goes out first and the notice's
 * clock starts when it is stamped as sent. The policy enforces the same thing
 * from its side (0056): a notice with no `notified_at` reaches no domain row,
 * so even a sweep that got this wrong could not move an origin nobody was told
 * about.
 *
 * **Nothing names the other winery**, in any of the four messages.
 *
 * **Mail first, stamp second.** A run that fails between the two sends the same
 * message again on the next run rather than never sending it — a duplicate
 * notice is an annoyance, a missing one is the failure this whole row exists
 * to prevent.
 */

export interface ClaimSweepDeps {
  /** A sender whose suppression check reads as the named winery. */
  readonly senderFor: (tenantId: string) => SendEmail;
  /** Where a seller manages domains, linked from every message. */
  readonly manageUrl: string;
  readonly readWork?: () => Promise<readonly ClaimWork[]>;
  readonly settle?: typeof settleDomainClaim;
  readonly recipientsOf?: (tenantId: string) => Promise<OwnerRecipients | undefined>;
  readonly markNotified?: (claim: ClaimWork, noticeHours: number) => Promise<unknown>;
  readonly capOf?: (tenantId: string) => Promise<number>;
  readonly now?: () => Date;
  readonly log?: (line: string) => void;
}

export interface ClaimSweepResult {
  readonly noticesSent: number;
  readonly settled: number;
  readonly outcomesTold: number;
  readonly failed: number;
}

/** One of the claim messages, with the props its template takes. */
type Message = {
  [K in TemplateName]: { readonly template: K; readonly props: TemplateProps[K] };
}[TemplateName];

const localeOf = (value: string): Locale =>
  (LOCALES as readonly string[]).includes(value) ? (value as Locale) : 'it';

/** The deadline as a person reads it, in Italian time — the sellers are Italian. */
export const formatDeadline = (at: Date, locale: Locale): string =>
  `${new Intl.DateTimeFormat(locale === 'it' ? 'it-IT' : 'en-GB', {
    dateStyle: 'long',
    timeStyle: 'short',
    timeZone: 'Europe/Rome',
  }).format(at)} (${locale === 'it' ? 'ora italiana' : 'Italian time'})`;

const defaultRecipients = (tenantId: string) => withTenant(tenantId, readOwnerRecipients);

const defaultMarkNotified = (claim: ClaimWork, noticeHours: number) =>
  withTenant(claim.claimantTenantId, (tx) =>
    markClaimNotified(tx, claim.id, claim.status, noticeHours),
  );

const defaultCap = async (tenantId: string): Promise<number> =>
  capFor((await withTenant(tenantId, readTenantPlan)) ?? 'none');

export const sweepClaims = async ({
  senderFor,
  manageUrl,
  readWork = () => readClaimWork(),
  settle = (input) => settleDomainClaim(input),
  recipientsOf = defaultRecipients,
  markNotified = defaultMarkNotified,
  capOf = defaultCap,
  now = () => new Date(),
  log = (line) => process.stdout.write(`${line}\n`),
}: ClaimSweepDeps): Promise<ClaimSweepResult> => {
  let noticesSent = 0;
  let settled = 0;
  let outcomesTold = 0;
  let failed = 0;

  /** Mails every owner of one winery, in that winery's language. */
  const tell = async (
    tenantId: string,
    compose: (recipients: OwnerRecipients, locale: Locale) => Message,
  ): Promise<void> => {
    const recipients = await recipientsOf(tenantId);

    if (recipients === undefined) return;

    const locale = localeOf(recipients.locale);
    const sender = senderFor(tenantId);

    for (const owner of recipients.owners) {
      await sender({ ...compose(recipients, locale), to: owner, locale });
    }
  };

  const tellOutcome = async (claim: ClaimWork): Promise<void> => {
    if (claim.status === 'TRANSFERRED') {
      if (claim.incumbentTenantId !== null) {
        await tell(claim.incumbentTenantId, (r) => ({
          template: 'domain-claim-lost',
          props: { tenantName: r.tenantName, domain: claim.origin, manageUrl },
        }));
      }

      /* Only a claim that waited out a notice: an immediate one was at the screen. */
      if (claim.notifiedStatus === 'NOTICE') {
        await tell(claim.claimantTenantId, (r) => ({
          template: 'domain-claim-won',
          props: { tenantName: r.tenantName, domain: claim.origin, manageUrl },
        }));
      }
    } else {
      await tell(claim.claimantTenantId, (r) => ({
        template: 'domain-claim-withdrawn',
        props: { tenantName: r.tenantName, domain: claim.origin, manageUrl },
      }));
    }

    await markNotified(claim, CLAIM_NOTICE_HOURS);
    outcomesTold += 1;
  };

  for (const claim of await readWork()) {
    try {
      if (claim.status === 'NOTICE' && claim.due) {
        /*
         * Settled through the claim scope, which re-checks everything under the
         * policy — a notice withdrawn a moment ago, or one the policy does not
         * consider sent, is simply unsettleable.
         */
        const outcome = await settle({
          claimId: claim.id,
          claimantTenantId: claim.claimantTenantId,
          cap: await capOf(claim.claimantTenantId),
          noticeHours: CLAIM_NOTICE_HOURS,
          actor: {},
        });

        if (outcome.kind === 'transferred') {
          settled += 1;
          await tellOutcome({ ...claim, status: 'TRANSFERRED' });
        }
      } else if (claim.status === 'NOTICE') {
        /* The holder is told first, and the notice's clock starts when that is recorded. */
        const holder = claim.incumbentTenantId;

        if (holder !== null) {
          const deadline = new Date(now().getTime() + CLAIM_NOTICE_HOURS * 3_600_000);

          await tell(holder, (r, locale) => ({
            template: 'domain-claim-notice',
            props: {
              tenantName: r.tenantName,
              domain: claim.origin,
              transferOn: formatDeadline(deadline, locale),
              manageUrl,
            },
          }));
        }

        await markNotified(claim, CLAIM_NOTICE_HOURS);
        noticesSent += 1;
      } else {
        await tellOutcome(claim);
      }
    } catch (error) {
      /* One claim failing is retried on the next run; the rest still get theirs. */
      failed += 1;
      log(
        JSON.stringify({
          level: 'error',
          kind: 'claim_sweep_failed',
          claimId: claim.id,
          type: error instanceof Error ? error.name : 'unknown',
        }),
      );
    }
  }

  return { noticesSent, settled, outcomesTold, failed };
};

/**
 * A sender per winery, over one transport, with that winery's suppression check.
 *
 * Composed exactly as the API composes its own (`composition.ts`): outside
 * production every message goes to the log unless its address is on the
 * allowlist, so a staging run against restored data cannot mail a customer.
 */
export const sendersFrom = (
  env: NodeJS.ProcessEnv = process.env,
  log = logTransport(),
): ((tenantId: string) => SendEmail) => {
  const apiKey = env.RESEND_API_KEY;
  const transport = chooseTransport({
    /* Not `production` unless it says so: an unset stage logs mail rather than sending it. */
    stage: env.SST_STAGE ?? 'unknown',
    provider:
      apiKey === undefined || apiKey === ''
        ? log
        : resendTransport({ apiKey, fetch: globalThis.fetch }),
    log,
    allowlist: env.EMAIL_ALLOWLIST?.split(',').map((address) => address.trim()),
  });

  return (tenantId) =>
    createSendEmail({
      transport,
      from: env.EMAIL_FROM ?? 'AI Sommelier <noreply@localhost>',
      suppression: {
        isSuppressed: (address) => withTenant(tenantId, (tx) => isSuppressed(tx, address)),
      },
    });
};

/** The Lambda entry point, on the schedule in `infra/schedules.ts`. */
export const handler = async (): Promise<ClaimSweepResult> => {
  const result = await sweepClaims({
    senderFor: sendersFrom(),
    /* The dashboard's origin, as the API's invitation links use it. */
    manageUrl: `${process.env.AUTH_BASE_URL ?? 'http://localhost:5173'}/domini`,
  });

  process.stdout.write(`${JSON.stringify({ level: 'info', kind: 'claim_sweep', ...result })}\n`);

  return result;
};
