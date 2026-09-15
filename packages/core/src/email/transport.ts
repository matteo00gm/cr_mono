import { normaliseAddress } from './address.js';

/**
 * The transport port and its two implementations (P0-64).
 *
 * Resend appears in exactly one function in this file and nowhere else in the
 * repository. That is the whole point of the seam: swapping providers — which
 * transactional email vendors force on you eventually, through pricing or
 * through an account review — is one implementation rather than a search for
 * every place that sent a message.
 */

export interface OutboundEmail {
  /** Already normalised and validated by `sendEmail`. */
  readonly to: string;
  readonly from: string;
  readonly subject: string;
  readonly html: string;
  /** Never optional. A missing plaintext part is a deliverability own-goal. */
  readonly text: string;
  /**
   * The same for every attempt at one message, and different for every message.
   *
   * What makes a retry safe (review fix). A request whose answer never arrived
   * may still have been sent, and without a key a retry would mail the reset
   * link twice; with one, the provider answers the repeat with the first result.
   */
  readonly idempotencyKey: string;
}

export interface SendResult {
  /** The provider's id, for correlating with a later bounce webhook. */
  readonly id: string;
}

export interface EmailTransport {
  /** Named so a log line says which transport actually ran. */
  readonly name: string;
  send(email: OutboundEmail): Promise<SendResult>;
}

/**
 * A provider rejection, with the one bit the caller needs.
 *
 * `retryable` is decided here rather than by the caller inspecting a status
 * code, because "which of these is worth trying again" is provider knowledge
 * and belongs with the provider. Retrying a 422 forever is how a free-tier
 * quota is spent on a message that will never be accepted.
 */
export class EmailSendError extends Error {
  public readonly status: number;
  public readonly retryable: boolean;

  constructor(message: string, status: number, retryable: boolean) {
    super(message);
    this.name = 'EmailSendError';
    this.status = status;
    this.retryable = retryable;
  }
}

/* ------------------------------------------------------------------ Resend */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/**
 * How long one attempt waits for Resend to answer.
 *
 * **Without a limit, a connection that hangs is not a failure at all** — it is
 * a request that waits until the API function's ten-second timeout kills it,
 * with no retry and no alarm (review fix). Two seconds is many times what the
 * provider takes on a good day, and three attempts at it, plus the backoff
 * between them, still end inside the function that is sending.
 */
export const RESEND_TIMEOUT_MS = 2_000;

/** The error's class name, which says what went wrong without carrying anything it touched. */
const nameOf = (error: unknown): string => (error instanceof Error ? error.name : typeof error);

/**
 * `fetch` is injected rather than reached for globally, so the tests here are
 * plain unit tests with no network and no interception — the same reason
 * `ParameterStore` is a port in `config.ts`.
 */
export const resendTransport = (options: {
  readonly apiKey: string;
  readonly fetch: typeof globalThis.fetch;
  /** Injected so the timeout test does not wait two real seconds. */
  readonly timeoutMs?: number | undefined;
}): EmailTransport => ({
  name: 'resend',
  async send(email) {
    let response: Response;

    try {
      response = await options.fetch(RESEND_ENDPOINT, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${options.apiKey}`,
          'content-type': 'application/json',
          // Resend keeps a key for 24 hours and answers a repeat with the first result.
          'idempotency-key': email.idempotencyKey,
        },
        body: JSON.stringify({
          from: email.from,
          to: [email.to],
          subject: email.subject,
          html: email.html,
          text: email.text,
        }),
        signal: AbortSignal.timeout(options.timeoutMs ?? RESEND_TIMEOUT_MS),
      });
    } catch (error: unknown) {
      /*
       * **No answer at all** — DNS, a reset connection, or nothing back within
       * the timeout (review fix). This used to escape as a bare `TypeError`,
       * which `sendEmail` reads as not retryable, so one network blip abandoned
       * a password reset on its first attempt. It is the most retryable failure
       * there is, and the idempotency key is what makes retrying it safe.
       *
       * The name only: a network error's message can carry the URL, and the
       * status is 0 because no status ever arrived.
       */
      throw new EmailSendError(`Resend could not be reached (${nameOf(error)})`, 0, true);
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      throw new EmailSendError(
        `Resend rejected the message: ${String(response.status)} ${detail}`.trim(),
        response.status,
        /*
         * 429 is the free tier's daily and per-second limits, and 5xx is the
         * provider having a bad minute. 409 is Resend saying the same key is
         * still being processed by an earlier attempt, which its documentation
         * calls safe to retry once that attempt finishes. Everything else — a
         * malformed address, an unverified sending domain, a revoked key — is a
         * request that will be rejected identically on every attempt.
         */
        response.status === 409 || response.status === 429 || response.status >= 500,
      );
    }

    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== 'string') {
      throw new EmailSendError(
        'Resend accepted the message but returned no id. Without one a later ' +
          'bounce webhook cannot be matched to what we sent.',
        response.status,
        false,
      );
    }

    return { id: body.id };
  },
});

/* --------------------------------------------------------------------- log */

/**
 * Writes the message where an operator can read it and returns a synthetic id.
 *
 * The non-production default. It is not a stub — the whole message is rendered
 * and logged, so template bugs surface in development exactly as they would in
 * production, minus the part that spends quota and reputation.
 */
export const logTransport = (
  log: (line: string) => void = (line) => {
    console.info(line);
  },
): EmailTransport => ({
  name: 'log',
  send(email) {
    log(
      `[email] to=${email.to} from=${email.from} subject=${JSON.stringify(email.subject)}\n` +
        email.text,
    );
    // Prefixed so it can never be mistaken for a provider id in a log search.
    return Promise.resolve({ id: `log-${String(Date.now())}` });
  },
});

/* ------------------------------------------------------------------ choice */

/**
 * Picks the transport, and it is a guard rather than a convenience.
 *
 * The free tier allows **one sending domain**, so staging cannot have its own.
 * That constraint points the same way the safety argument does: a staging run
 * against a restored production database must not be able to mail real
 * customers, and "we will remember not to" is not a control. So outside
 * production, mail goes to the log — with one exception, an explicit list of
 * addresses for manual testing, which is how the real path gets exercised at
 * all before it carries something that matters.
 *
 * The exception is per *recipient*, not a flag that switches the whole stage
 * over. A flag is one careless deploy away from mailing a customer list; an
 * address list can only ever reach the addresses on it.
 */
export const chooseTransport = (options: {
  readonly stage: string;
  readonly provider: EmailTransport;
  readonly log: EmailTransport;
  /** Addresses that may receive real mail from a non-production stage. */
  readonly allowlist?: readonly string[] | undefined;
}): EmailTransport => {
  if (options.stage === 'production') return options.provider;

  const allowed = new Set((options.allowlist ?? []).map(normaliseAddress));

  return {
    name: `guarded(${options.log.name})`,
    send(email) {
      const transport = allowed.has(normaliseAddress(email.to)) ? options.provider : options.log;
      return transport.send(email);
    },
  };
};
