/**
 * What a seller claiming a held domain is told (P4-18).
 *
 * **Nothing here names the holder, or says anything about it that the flow
 * does not have to.** Proving control of a zone entitles a seller to the
 * origin, not to learn who our customer was. The one thing the flow cannot
 * hide is whether the origin moved at once or after a notice — a seller has to
 * be told when it will be theirs — and that is all these messages say.
 */

/**
 * How long a paying holder has to answer a proven claim.
 *
 * Seventy-two hours: long enough to span a weekend, short enough that a new
 * owner is not locked out of their own storefront for a week. Transferring a
 * paying customer's origin on a single DNS check is how a hostile contractor or
 * a compromised registrar silently kills a live widget, and this is the window
 * in which somebody notices. Handed to the settlement, which writes the deadline
 * it is given — so the message below and the stored deadline cannot drift.
 */
export const CLAIM_NOTICE_HOURS = 72;

/** Counted per claim, on the same allowance as a first verification (P4-02). */
export const claimVerifyLimitKey = (claimId: string): string => `claim-verify:${claimId}`;

export const CLAIM_TRANSFERRED =
  'Verified. The domain is on your account now, and your widget can run on it straight away.';

/**
 * A paying holder has been put on notice.
 *
 * The hours are the ones handed to the statement that sets the deadline, so
 * the two cannot drift — and the exact moment is in the response beside this,
 * for a screen that wants to show a date.
 */
export const CLAIM_NOTICED =
  `We found your record. The domain is in use, so its current holder has been given ` +
  `${String(CLAIM_NOTICE_HOURS)} hours to respond. If they do not, it moves to your ` +
  'account automatically.';

export const CLAIM_WITHDRAWN =
  'The current holder of that domain has kept it. If you believe that is wrong, contact support.';

export const CLAIM_ALREADY_YOURS = 'That domain is already on your account.';

export const CLAIM_RACED =
  'That domain changed hands while we were checking it. Check again in a moment.';
