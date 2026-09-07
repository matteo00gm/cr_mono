import { looksLikeAddress, normaliseAddress } from './address.js';
import { renderTemplate, type Locale, type TemplateName, type TemplateProps } from './templates.js';
import { EmailSendError, type EmailTransport } from './transport.js';

/**
 * `sendEmail` — the single seam every message in the product goes through
 * (P0-64).
 *
 * One function, so that four things are true of *every* message rather than of
 * the ones whose author remembered: it is checked against the suppression list,
 * it carries a plaintext part, it retries a rate-limit rejection, and a
 * permanent failure raises an alarm. Each of those is easy to get right once
 * and impossible to keep right in six call sites.
 */

/** The narrow read `sendEmail` needs, so this module has no database. */
export interface SuppressionCheck {
  isSuppressed(address: string): Promise<boolean>;
}

/** Nothing is suppressed. For tests and for the log transport in development. */
export const noSuppression: SuppressionCheck = { isSuppressed: () => Promise.resolve(false) };

export class InvalidRecipientError extends Error {
  constructor(address: string) {
    super(
      `"${address}" is not a usable email address. This is almost always a bug on ` +
        'our side — an undefined prop, or a display name where an address belongs — ' +
        'and sending it would count a guaranteed bounce against our domain.',
    );
    this.name = 'InvalidRecipientError';
  }
}

export type SendOutcome =
  | { readonly status: 'sent'; readonly id: string; readonly attempts: number }
  /**
   * Not an error. The address is on the suppression list, the message was not
   * sent, and that is the system working — so the caller gets a value it can
   * branch on rather than an exception it would be tempted to swallow.
   */
  | { readonly status: 'suppressed'; readonly address: string };

export interface SendFailure {
  readonly to: string;
  readonly template: TemplateName;
  readonly attempts: number;
  readonly error: unknown;
}

export interface SendEmailDeps {
  readonly transport: EmailTransport;
  /** `Sommelier <noreply@…>`; the domain must be the authenticated one. */
  readonly from: string;
  readonly suppression: SuppressionCheck;
  /**
   * Raised when a message is finally abandoned.
   *
   * A hook rather than a caller responsibility, because these are
   * account-recovery and billing messages: the failure that matters is the one
   * nobody noticed, and "the caller will log it" is how that happens.
   */
  readonly onFailure?: ((failure: SendFailure) => void) | undefined;
  /** Total attempts, including the first. */
  readonly attempts?: number | undefined;
  /** Injected so the retry test does not spend real seconds waiting. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injected so backoff jitter is deterministic under test. */
  readonly random?: (() => number) | undefined;
}

export interface SendEmailOptions<K extends TemplateName> {
  readonly to: string;
  readonly template: K;
  readonly props: TemplateProps[K];
  /** Italian by default — the customers are Italian wine sellers. */
  readonly locale?: Locale | undefined;
}

const DEFAULT_ATTEMPTS = 3;
const BASE_DELAY_MS = 500;

/**
 * Exponential backoff with full jitter.
 *
 * Jitter is not decoration here. The send that hits the daily cap is usually
 * one of a batch — period rollover mails every tenant at once — and a batch
 * that all backs off by exactly 500ms retries in lockstep, hits the per-second
 * limit again together, and turns one rejection into a synchronised stampede.
 */
const delayFor = (attempt: number, random: () => number): number =>
  Math.round(random() * BASE_DELAY_MS * 2 ** (attempt - 1));

/**
 * Builds the send function.
 *
 * A factory rather than a module-level function taking a dependency bag on
 * every call: the dependencies are fixed for the life of the process, and
 * threading them through each call site is how one of them ends up defaulted to
 * something convenient.
 */
export const createSendEmail = (deps: SendEmailDeps) => {
  const attemptLimit = deps.attempts ?? DEFAULT_ATTEMPTS;
  const sleep =
    deps.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = deps.random ?? Math.random;

  return async <K extends TemplateName>(options: SendEmailOptions<K>): Promise<SendOutcome> => {
    const to = normaliseAddress(options.to);
    if (!looksLikeAddress(to)) throw new InvalidRecipientError(options.to);

    /*
     * Checked before rendering, not after. Rendering is cheap, but the ordering
     * says what the rule is: a suppressed address is not mailed, and there is
     * no path through this function where a template's side effects run first.
     */
    if (await deps.suppression.isSuppressed(to)) return { status: 'suppressed', address: to };

    const rendered = renderTemplate(options.template, options.props, options.locale ?? 'it');
    const message = {
      to,
      from: deps.from,
      subject: rendered.subject,
      html: rendered.html,
      text: rendered.text,
    };

    let lastError: unknown;
    // The count actually made, not the limit. A permanent rejection abandoned
    // on the first try must not be reported to the alarm as three failures —
    // that is the difference between "bad address" and "provider is down".
    let made = 0;

    for (let attempt = 1; attempt <= attemptLimit; attempt += 1) {
      made = attempt;
      try {
        const result = await deps.transport.send(message);
        return { status: 'sent', id: result.id, attempts: attempt };
      } catch (error: unknown) {
        lastError = error;

        /*
         * A non-retryable rejection stops immediately. Retrying a 422 spends
         * the daily allowance on a message the provider has already explained
         * it will never accept — and on the free tier that allowance is shared
         * with the password resets.
         */
        const retryable = error instanceof EmailSendError ? error.retryable : false;
        if (!retryable || attempt === attemptLimit) break;

        await sleep(delayFor(attempt, random));
      }
    }

    deps.onFailure?.({ to, template: options.template, attempts: made, error: lastError });
    throw lastError;
  };
};

export type SendEmail = ReturnType<typeof createSendEmail>;
