import { z } from 'zod';

import { normaliseAddress } from '../email/address.js';

/**
 * What a Resend delivery event means for the suppression list (P0-64b).
 *
 * Pure, and separated from both the HTTP handler and the SQL for the usual
 * reason: the decision *whether an address should stop being mailed* is a
 * domain rule with real consequences in both directions, and it deserves a test
 * that is a table of payloads rather than a container and a fake request.
 */

/**
 * The event, parsed as loosely as it can be while still being useful.
 *
 * **`.catchall`-free, non-strict, and every field but `type` optional**, which
 * is the opposite of how request bodies are validated elsewhere in this
 * repository. The difference is who is sending: a request body is written by a
 * caller we are entitled to refuse, and a webhook payload is written by a
 * provider who will add fields without telling us. A strict schema here turns
 * *their* next release into *our* outage, and the outage is silent — deliveries
 * fail in a dashboard nobody on this side is watching.
 *
 * The signature is what makes this safe to be lenient about. By the time
 * anything is parsed, the bytes are known to have come from Resend.
 */
const resendEvent = z.object({
  type: z.string(),
  data: z
    .object({
      to: z.union([z.string(), z.array(z.string())]).optional(),
      email_id: z.string().optional(),
      bounce: z
        .object({
          /** `Permanent`, `Transient` or `Undetermined`. */
          type: z.string().optional(),
          /** `General`, `NoEmail`, `Suppressed`, `MailboxFull`, … */
          subType: z.string().optional(),
          message: z.string().optional(),
        })
        .optional(),
    })
    .optional(),
});

export type ResendEvent = z.infer<typeof resendEvent>;

export interface Suppression {
  readonly address: string;
  readonly reason: string;
  readonly detail?: string | undefined;
}

/** What the endpoint did, so the response and the log can say the same thing. */
export interface EventOutcome {
  /** `email.bounced`, or whatever arrived — echoed for the log, not trusted. */
  readonly type: string;
  readonly suppressions: readonly Suppression[];
}

export class UnreadableWebhookPayloadError extends Error {
  constructor() {
    super('The webhook payload was not an object carrying a `type`.');
    this.name = 'UnreadableWebhookPayloadError';
  }
}

/**
 * `instanceof` is not enough on its own, for the reason `isDomainError` gives.
 *
 * A Lambda bundle can end up with two copies of this module — a workspace link
 * beside a bundled one — and then `instanceof` is false for an object that is
 * this error in every way that matters. The consequence here is not cosmetic:
 * the API maps this error to a **400** and everything else to a 500, and a 5xx
 * is what makes the provider retry. So a missed identification turns a payload
 * we will never understand into a delivery that comes back for hours.
 */
export const isUnreadableWebhookPayload = (error: unknown): boolean =>
  error instanceof UnreadableWebhookPayloadError ||
  (error instanceof Error && error.name === 'UnreadableWebhookPayloadError');

/** `to` arrives as a string or an array depending on the event. */
const recipients = (to: string | readonly string[] | undefined): readonly string[] => {
  if (to === undefined) return [];
  return (typeof to === 'string' ? [to] : to).map(normaliseAddress).filter((a) => a !== '');
};

/**
 * **Only a permanent bounce suppresses**, and this is the decision in the file
 * worth arguing with.
 *
 * A hard bounce is a statement that the mailbox does not exist; mailing it
 * again is what moves a sending domain onto filter lists. A *transient* bounce
 * is a full mailbox or a greylisting, and the address belongs to a real person
 * who will read their mail next week. Suppressing on one of those produces
 * exactly the failure P0-64 exists to prevent — a paying customer who cannot
 * reset their password, with no self-service way back, because a mailbox was
 * full on the day they were invited.
 *
 * So an unknown or absent `bounce.type` does **not** suppress. That direction
 * is deliberate and is not the usual fail-closed instinct: the cost of missing
 * a suppression is one more message to a dead address, which bounces again and
 * arrives here again, while the cost of a wrong suppression is a locked-out
 * customer and a table only an operator can edit. The asymmetry decides it.
 */
const PERMANENT = 'permanent';

const bounceSuppressions = (event: ResendEvent): readonly Suppression[] => {
  const bounce = event.data?.bounce;
  if (bounce?.type?.toLowerCase() !== PERMANENT) return [];

  /*
   * Kept verbatim, including the provider's own wording. This column is read by
   * whoever is asking "why can this customer not receive mail", and a
   * normalised category answers that badly — `subType` is what distinguishes a
   * dead mailbox from a domain that no longer resolves.
   */
  const detail = [bounce.subType, bounce.message].filter((part) => part !== undefined).join(': ');

  return recipients(event.data?.to).map((address) => ({
    address,
    reason: 'hard_bounce',
    ...(detail === '' ? {} : { detail }),
  }));
};

/**
 * A complaint always suppresses, with no equivalent of the check above.
 *
 * Somebody pressed "this is spam". The address works perfectly, which is
 * precisely why continuing to mail it is worse than mailing a dead one: a
 * complaint rate is the single strongest negative signal a mailbox provider
 * acts on, and the sender has been told explicitly to stop.
 */
const complaintSuppressions = (event: ResendEvent): readonly Suppression[] =>
  recipients(event.data?.to).map((address) => ({
    address,
    reason: 'complaint',
    detail: 'reported as spam by the recipient',
  }));

/**
 * Reads an event and says which addresses must stop being mailed.
 *
 * **An unrecognised type is not an error.** It returns no suppressions and the
 * endpoint answers 200, because a provider that adds `email.delivered_delayed`
 * next month must not turn this endpoint into a wall of failures in their
 * dashboard — and every one of those failures is a retry, so rejecting what we
 * do not understand is how a working integration becomes a loop.
 */
export const suppressionsFor = (payload: unknown): EventOutcome => {
  const parsed = resendEvent.safeParse(payload);
  if (!parsed.success) throw new UnreadableWebhookPayloadError();

  const event = parsed.data;

  switch (event.type) {
    case 'email.bounced':
      return { type: event.type, suppressions: bounceSuppressions(event) };
    case 'email.complained':
      return { type: event.type, suppressions: complaintSuppressions(event) };
    default:
      return { type: event.type, suppressions: [] };
  }
};
