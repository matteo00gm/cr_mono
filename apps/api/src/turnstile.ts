/**
 * Turnstile, verified server-side (P4-14).
 *
 * **Only ever a second gate.** A winery turns it on when its widget is being
 * abused (§3.6); the session mint then asks for a token as well as the key,
 * origin and limits it already checks. The token proves a browser solved a
 * challenge — it says nothing about *which* site that browser was on, so the
 * verifier binds it to the origin CORS already verified.
 *
 * **Fails closed.** Cloudflare unreachable, slow, or answering anything but a
 * clean success is a refusal. This is switched on under attack, and a check
 * that waves requests through whenever the checker is down is a check an
 * attacker can switch off.
 *
 * A fixed Cloudflare host, not a user-supplied one, so this is a plain `fetch`
 * rather than `guardedFetch` (P4-03a).
 */

export const TURNSTILE_VERIFY_URL = 'https://challenges.cloudflare.com/turnstile/v0/siteverify';

/** What the widget renders the challenge for, and what the token must carry back. */
export const TURNSTILE_ACTION = 'session';

/** Cloudflare's own ceiling on a response token. Anything longer is not one. */
export const TURNSTILE_TOKEN_MAX = 2048;

/** Well inside the mint's own budget: a visitor is waiting on this. */
export const TURNSTILE_TIMEOUT_MS = 3000;

/** Told to a widget whose token was missing or refused. One answer for every reason. */
export const TURNSTILE_REFUSED =
  'The challenge could not be verified. Reload the page to try again.';

export interface TurnstileCheck {
  readonly token: string | undefined;
  /** The origin CORS verified for this request. */
  readonly origin: string;
  readonly remoteIp: string | undefined;
}

export type TurnstileVerifier = (check: TurnstileCheck) => Promise<boolean>;

interface SiteverifyAnswer {
  readonly success?: unknown;
  readonly hostname?: unknown;
  readonly action?: unknown;
}

const hostnameOf = (origin: string): string | undefined => {
  try {
    return new URL(origin).hostname;
  } catch {
    return undefined;
  }
};

export const createTurnstileVerifier =
  ({
    secret,
    fetch: fetch_ = globalThis.fetch,
    timeoutMs = TURNSTILE_TIMEOUT_MS,
  }: {
    readonly secret: string;
    readonly fetch?: typeof globalThis.fetch | undefined;
    readonly timeoutMs?: number | undefined;
  }): TurnstileVerifier =>
  async ({ token, origin, remoteIp }) => {
    /* Nothing to ask Cloudflare about costs Cloudflare nothing. */
    if (token === undefined || token === '' || token.length > TURNSTILE_TOKEN_MAX) return false;

    const expected = hostnameOf(origin);

    if (expected === undefined) return false;

    const form = new URLSearchParams({ secret, response: token });

    if (remoteIp !== undefined) form.set('remoteip', remoteIp);

    try {
      const response = await fetch_(TURNSTILE_VERIFY_URL, {
        method: 'POST',
        body: form,
        signal: AbortSignal.timeout(timeoutMs),
      });

      if (!response.ok) return false;

      const answer = (await response.json()) as SiteverifyAnswer;

      /*
       * **All three, exactly.** `success` alone would accept a token solved on
       * any site that embeds our site key — every seller's page — for a session
       * on this one; the hostname is what ties it to the origin being served.
       * `action` stops a token solved for some other purpose being spent here.
       */
      return (
        answer.success === true &&
        answer.hostname === expected &&
        answer.action === TURNSTILE_ACTION
      );
    } catch {
      return false;
    }
  };
