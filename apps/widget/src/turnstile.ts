/**
 * The Turnstile challenge, for a winery that turned it on (P4-14).
 *
 * **Nothing here runs unless the config names a site key**, and by default it
 * does not — so the default widget loads nothing from a third party, which is
 * the point of the flag being off (§3.6). When it does, Cloudflare's script is
 * added once, on the first mint that needs it, never at load.
 *
 * `interaction-only`: most visitors never see anything, and one Cloudflare
 * doubts is shown the challenge inside the panel rather than a page of its
 * own.
 */

export const TURNSTILE_SCRIPT =
  'https://challenges.cloudflare.com/turnstile/v0/api.js?render=explicit';

/** What the widget renders the challenge for; the API refuses a token for anything else. */
export const TURNSTILE_ACTION = 'session';

/** The slice of Cloudflare's API the widget uses. */
export interface TurnstileApi {
  readonly render: (
    container: HTMLElement,
    options: {
      readonly sitekey: string;
      readonly action: string;
      readonly appearance: 'interaction-only';
      readonly callback: (token: string) => void;
      readonly 'error-callback': () => void;
      readonly 'expired-callback': () => void;
    },
  ) => string | undefined;
  readonly remove?: ((widgetId: string) => void) | undefined;
}

export class ChallengeFailed extends Error {
  constructor(reason: string) {
    super(`The Turnstile challenge did not complete: ${reason}.`);
    this.name = 'ChallengeFailed';
  }
}

let loading: Promise<TurnstileApi> | undefined;

/**
 * Cloudflare's script, added at most once per page.
 *
 * Single-flight, and a failure is not cached: a visitor whose first load was
 * blocked by a flaky network gets another try on the next question. A page that
 * already has Turnstile — a seller using it themselves — is used as it is.
 */
export const loadTurnstile = (document_: Document = document): Promise<TurnstileApi> => {
  const present = (globalThis as { turnstile?: TurnstileApi }).turnstile;

  if (present !== undefined) return Promise.resolve(present);

  loading ??= new Promise<TurnstileApi>((resolve, reject) => {
    const script = document_.createElement('script');

    script.src = TURNSTILE_SCRIPT;
    script.async = true;
    script.addEventListener('load', () => {
      const api = (globalThis as { turnstile?: TurnstileApi }).turnstile;

      if (api === undefined) reject(new ChallengeFailed('the script loaded without its API'));
      else resolve(api);
    });
    script.addEventListener('error', () => {
      reject(new ChallengeFailed('the script did not load'));
    });

    document_.head.append(script);
  }).catch((error: unknown) => {
    loading = undefined;
    throw error;
  });

  return loading;
};

/**
 * A token, solved fresh for each mint: Turnstile tokens are single-use, and a
 * refresh is a mint like any other. Rendered into its own element inside the
 * panel, removed once it has answered.
 */
export const createChallenge =
  ({
    siteKey,
    container,
    load = loadTurnstile,
    document: document_ = document,
  }: {
    readonly siteKey: string;
    readonly container: HTMLElement;
    readonly load?: ((document_: Document) => Promise<TurnstileApi>) | undefined;
    readonly document?: Document | undefined;
  }) =>
  async (): Promise<string> => {
    const api = await load(document_);
    const slot = document_.createElement('div');

    container.append(slot);

    let widgetId: string | undefined;

    try {
      return await new Promise<string>((resolve, reject) => {
        widgetId = api.render(slot, {
          sitekey: siteKey,
          action: TURNSTILE_ACTION,
          appearance: 'interaction-only',
          callback: resolve,
          'error-callback': () => {
            reject(new ChallengeFailed('Cloudflare reported an error'));
          },
          'expired-callback': () => {
            reject(new ChallengeFailed('the challenge expired'));
          },
        });
      });
    } finally {
      if (widgetId !== undefined) api.remove?.(widgetId);
      slot.remove();
    }
  };

/** For a test: forget the script, as a fresh page would. */
export const forgetTurnstile = (): void => {
  loading = undefined;
};
