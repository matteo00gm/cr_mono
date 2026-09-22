import type { WidgetConfigResponse } from '@catalogorosso/api-client';

/**
 * What the widget learns before it loads anything (P3-03, §1.2 steps 2–3).
 *
 * **A `DISABLED` tenant must cost us nothing**, and "nothing" is precise: no
 * main bundle, no session, no model call, no query beyond the one cached config
 * read. A seller who switched their widget off is usually a seller thinking
 * about cancelling, and a switched-off widget that still spends money is the
 * worst possible answer to that.
 *
 * **`credentials: 'omit'`, always.** This surface accepts no cookies (P2-08
 * sets `Access-Control-Allow-Credentials: false`), and sending them anyway
 * would be a request the browser refuses for a reason nobody reading this file
 * would guess.
 *
 * **The config lives in memory and nowhere else.** No `localStorage`, no
 * cookie: it is a per-page fact that is edge-cached for a minute anyway, and
 * storing it on a visitor's device is a tracking decision nobody made.
 */

/** Where P2-10's config lives, relative to the API origin the loader captured. */
export const CONFIG_PATH = '/v1/widget/config';

/** How many times a network failure is retried before the widget gives up for this page. */
export const MAX_ATTEMPTS = 3;

/** The first backoff, doubled each time. Small, because a visitor is looking at the page. */
export const FIRST_BACKOFF_MS = 400;

/**
 * What the widget is, right now.
 *
 * `disabled` and `error` are different states on purpose: the first is the
 * seller's own choice and says so quietly (§1.3), and the second is ours and
 * should not pretend to be theirs.
 */
export type WidgetState =
  | { readonly kind: 'active'; readonly config: WidgetConfigResponse }
  | { readonly kind: 'disabled'; readonly config: WidgetConfigResponse }
  | { readonly kind: 'error' };

export interface BootstrapOptions {
  readonly api: string;
  readonly key: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
  /** Injected so a test can assert the backoff without waiting for it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  readonly maxAttempts?: number | undefined;
}

const wait = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

/**
 * Reads the tenant's configuration, retrying only what is worth retrying.
 *
 * **A refusal is not retried.** A 403 means this key and this origin do not
 * belong together (P2-08), which is a seller's setup mistake and will be a
 * setup mistake on the fourth attempt too — retrying it turns one refused
 * request into four and tells the seller nothing new. Only a network failure
 * and a 5xx get another go.
 *
 * **The shape is validated by the caller, not here** *(and the type is the
 * contract)*: `WidgetConfigResponse` comes from `@catalogorosso/api-client`, so
 * a field the server stops sending fails the build rather than the page.
 */
export const readConfig = async ({
  api,
  key,
  fetch: fetch_ = globalThis.fetch,
  sleep = wait,
  maxAttempts = MAX_ATTEMPTS,
}: BootstrapOptions): Promise<WidgetState> => {
  const url = `${api}${CONFIG_PATH}?key=${encodeURIComponent(key)}`;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const response = await fetch_(url, {
        method: 'GET',
        /* This surface accepts no cookies, and asking is how CORS fails (P2-08). */
        credentials: 'omit',
        headers: { accept: 'application/json' },
      });

      if (response.status >= 400 && response.status < 500) {
        /*
         * The seller's setup, not the network. A 403 is the key and the Origin
         * disagreeing and a 429 is a limit — both are answers, and asking again
         * changes neither while costing the tenant another counted request.
         */
        return { kind: 'error' };
      }

      if (response.ok) {
        const config = (await response.json()) as WidgetConfigResponse;

        return { kind: config.status === 'ACTIVE' ? 'active' : 'disabled', config };
      }
    } catch {
      /*
       * A network failure. Swallowed rather than logged, for the loader's
       * reason: there is no console on a seller's page that is ours to write
       * to, and the retry below is the whole of what we can usefully do.
       */
    }

    if (attempt < maxAttempts) await sleep(FIRST_BACKOFF_MS * 2 ** (attempt - 1));
  }

  return { kind: 'error' };
};
