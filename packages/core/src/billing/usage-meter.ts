import { quotaStateOf } from '@catalogorosso/security';

/**
 * The month as a seller reads it (P5-12, §2.3): how far through it they are,
 * where it is heading, and the two points at which they are told.
 *
 * Calendar months in UTC, because the ledger's `period` is (`periodOf`): a
 * meter on another calendar would disagree with the gate about which message
 * was the last one.
 */

/** A month's notices: four fifths of the allowance, and all of it. Sent once each. */
export type QuotaThreshold = 80 | 100;

/**
 * The threshold `used` messages have reached, or `undefined` below the first.
 *
 * **The widget's own states, renamed** (`quotaStateOf`): `near` is the 80%
 * notice and `exceeded` the 100% one, so the email, the banner and the widget
 * cannot disagree about where a winery stands. An allowance of nought — a plan
 * that sells nothing — is already exceeded.
 */
export const thresholdReached = (used: number, allowance: number): QuotaThreshold | undefined => {
  const state = quotaStateOf(used, allowance);

  if (state === 'exceeded') return 100;

  return state === 'near' ? 80 : undefined;
};

const DAY_MS = 86_400_000;

/** The first instant of the month after the one `at` falls in: when the quota resets. */
export const periodEnd = (at: Date): Date =>
  new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1));

/**
 * Where the month is heading, from the rate so far (§2.3).
 *
 * **Sane on a partial month**: the rate is never taken over less than a day,
 * so the first hours of a month — a dozen messages by breakfast — do not
 * project into thousands. Never below what is already used, and without a
 * floor to say so: the rate is taken over no more than the month, so carrying
 * it to the month's end cannot shrink it.
 */
export const projectMonth = (used: number, now: Date): number => {
  const start = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1);
  const days = (periodEnd(now).getTime() - start) / DAY_MS;
  const elapsed = Math.max((now.getTime() - start) / DAY_MS, 1);

  return Math.round((used / elapsed) * days);
};
