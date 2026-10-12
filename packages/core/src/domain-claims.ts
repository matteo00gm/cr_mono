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
  'Verificato. Il dominio ora è nel tuo account, e il widget può funzionarci da subito.';

/**
 * A paying holder has been put on notice.
 *
 * The hours are the ones handed to the statement that sets the deadline, so
 * the two cannot drift — and the exact moment is in the response beside this,
 * for a screen that wants to show a date.
 */
export const CLAIM_NOTICED =
  `Abbiamo trovato il tuo record. Il dominio è in uso, quindi chi lo ha ora ha ` +
  `${String(CLAIM_NOTICE_HOURS)} ore per rispondere. Se non lo fa, passa al tuo account ` +
  'in automatico.';

export const CLAIM_WITHDRAWN =
  'Chi ha questo dominio lo ha tenuto. Se pensi sia un errore, scrivi all’assistenza.';

export const CLAIM_ALREADY_YOURS = 'Questo dominio è già nel tuo account.';

export const CLAIM_RACED =
  'Il dominio è passato di mano mentre lo controllavamo. Controlla di nuovo fra un momento.';
