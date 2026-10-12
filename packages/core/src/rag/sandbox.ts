/**
 * An answer in the sandbox, on request (P2-37b, Open Decision 8).
 *
 * P2-37's sandbox shows retrieval and stops there, because most complaints are
 * retrieval problems and a model call costs money. A seller tuning a catalogue
 * still wants to read the answer, so one can be asked for — one at a time, and
 * **never free**: it is a real turn, billed as one of the winery's own messages
 * against the same monthly gate a visitor's is (P2-36). The sandbox then costs
 * us nothing a winery has not already paid for.
 *
 * What is here is the part with no database and no HTTP: how often, under which
 * key, and what a seller is told when the answer is no. Italian, like every
 * refusal the dashboard shows (P6-12).
 */

/**
 * How many answers one winery may ask for in a minute.
 *
 * A person reading each answer does not get near this. What it bounds is a
 * script holding a member's session and a button: each call is a model call,
 * and the monthly gate bounds the total but not how fast it is spent.
 */
export const SANDBOX_ANSWERS_PER_MINUTE = 10;
export const SANDBOX_ANSWER_WINDOW_SEC = 60;

/** The key a winery's sandbox answers are counted under: per winery, whoever asks. */
export const sandboxAnswerLimitKey = (tenantId: string): string => `sandbox:answer:${tenantId}`;

export const SANDBOX_TOO_FAST =
  `Qui puoi chiedere fino a ${String(SANDBOX_ANSWERS_PER_MINUTE)} risposte al minuto. ` +
  'Aspetta un momento e riprova.';

/**
 * What a winery at its cap is told — as the widget would be refused, and in
 * the words of somebody who can do something about it. A visitor is told
 * nothing of the plan (§1.3); this is the winery's own member, and the way out
 * is on a screen they or an owner can open.
 */
export const SANDBOX_QUOTA_EXCEEDED =
  'Questa cantina ha usato tutti i messaggi del mese, e una risposta di prova conta come un ' +
  'messaggio. Acquista dei messaggi extra o cambia piano nella schermata Fatturazione.';

/**
 * What a winery whose widget is not being served is told.
 *
 * One sentence for every reason — no verified domain yet, a trial that ended,
 * a payment that failed — because the way forward is in the same two places.
 */
export const SANDBOX_NOT_SERVED =
  'Il sommelier di questa cantina non è attivo, quindi non può rispondere nemmeno qui. ' +
  'Verifica un dominio per iniziare la prova, oppure controlla il piano nella schermata ' +
  'Fatturazione.';
