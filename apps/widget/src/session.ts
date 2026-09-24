import type { WidgetSessionResponse } from '@catalogorosso/api-client';

/**
 * The visitor's session (P3-16, §1.7, §3.4).
 *
 * **The token never touches storage.** Not `localStorage`, not
 * `sessionStorage`, not a cookie. It lives in a closure for as long as the page
 * does and goes away with it. The reason is the threat model: this code runs on
 * a seller's storefront, we do not control what else is on that page, and any
 * XSS anywhere on it can read either storage. A token that is only ever a
 * variable is one an injected script has to find rather than fetch.
 *
 * **A closure rather than a module-level `let`.** The guarantee is the same —
 * nothing writes it anywhere durable — and a closure is the version a test can
 * assert about, because each case gets its own. A module global would be shared
 * between cases and the "neither storage holds it" test would be proving
 * something about the previous test's leftovers.
 *
 * **No cookies, deliberately.** The widget surface sets
 * `Access-Control-Allow-Credentials: false` (P2-08), so a cookie would not be
 * sent even if we set one — and setting one anyway on somebody else's domain is
 * a tracking decision nobody made.
 */

/** Where P2-12's session mint lives, relative to the API origin the loader captured. */
export const SESSION_PATH = '/v1/widget/session';

/**
 * The anonymous id's key in `sessionStorage`.
 *
 * Prefixed, because this is a seller's own storage and a bare `visitor` is a
 * name somebody else's script will eventually want.
 */
export const ANON_ID_KEY = 'sommelier.visitor';

export interface SessionOptions {
  readonly api: string;
  readonly key: string;
  readonly fetch?: typeof globalThis.fetch | undefined;
}

export interface Session {
  /** The current token, minting one on first use. Concurrent callers share one request. */
  readonly token: () => Promise<string>;
  /** Drops the token, so the next caller mints a fresh one. P3-21 calls this on a 401. */
  readonly forget: () => void;
}

/**
 * Reads a value from a storage that is allowed to not work.
 *
 * **Every access is wrapped**, because `sessionStorage` is not a property that
 * always exists and always answers: Safari in private mode threw historically,
 * a blocked-site-data setting throws today, and a sandboxed iframe throws on
 * the *getter* — before any method is called. An exception here would break the
 * widget entirely, on a seller's site, for the visitors most likely to have
 * locked their browser down.
 */
const read = (key: string): string | undefined => {
  try {
    return globalThis.sessionStorage.getItem(key) ?? undefined;
  } catch {
    return undefined;
  }
};

/** True when the value is actually stored, which a browser is entitled to refuse. */
const write = (key: string, value: string): boolean => {
  try {
    globalThis.sessionStorage.setItem(key, value);

    return true;
  } catch {
    /* Nothing to do and nothing to say: the id simply does not survive a reload. */
    return false;
  }
};

/** Held only when storage refused, so such a browser still has one id per page. */
let fallbackId: string | undefined;

/**
 * An id for this visitor in this tab, and nothing more.
 *
 * **It identifies a tab, not a person.** `sessionStorage` is cleared when the
 * tab closes and is not shared with another tab, which is the whole of the
 * privacy claim: it exists so a reload does not look like a stranger, and it
 * cannot follow anybody anywhere.
 *
 * **Not the token, and never the token.** The distinction is the row: this is
 * worth nothing if it leaks, and the token is worth a month of somebody's
 * quota.
 */
export const anonId = (): string => {
  const stored = read(ANON_ID_KEY);

  if (stored !== undefined && stored !== '') return stored;

  const fresh = globalThis.crypto.randomUUID();

  /*
   * **Storage is the source of truth, and the memory copy is only a fallback.**
   * Caching it here unconditionally would be a cache that outlives what it
   * caches: another script on the seller's page can clear `sessionStorage`, and
   * the widget would go on handing out an id that is no longer stored anywhere.
   */
  if (write(ANON_ID_KEY, fresh)) return fresh;

  fallbackId ??= fresh;

  return fallbackId;
};

/**
 * Mints and holds a session token.
 *
 * **The promise is cached, not the token.** Two questions asked in the same
 * second must not mint two sessions — and the case that catches a resolved-value
 * cache is the second call arriving *before* the first request has come back,
 * which is the common one for a visitor who opens the panel and types
 * immediately. Same reasoning as P3-04's module cache.
 *
 * **A previous token continues its session** (P2-12a): `forget` exists so P3-21
 * can refresh one, and a refresh that dropped the session id would start the
 * conversation over in the middle.
 */
export const createSession = ({
  api,
  key,
  fetch: fetch_ = globalThis.fetch,
}: SessionOptions): Session => {
  let pending: Promise<string> | undefined;

  const mint = async (): Promise<string> => {
    const response = await fetch_(`${api}${SESSION_PATH}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      /* This surface accepts no cookies, and asking is how CORS fails (P2-08). */
      credentials: 'omit',
      headers: { accept: 'application/json' },
    });

    if (!response.ok)
      throw new Error(`The session endpoint refused with ${String(response.status)}.`);

    const session = (await response.json()) as WidgetSessionResponse;

    return session.token;
  };

  return {
    token: () => {
      pending ??= mint().catch((error: unknown) => {
        /*
         * A failed mint is not cached. Caching the rejection would leave a
         * visitor unable to ask anything for the rest of the page, with nothing
         * anywhere saying why — the same trap P3-04's loader avoids.
         */
        pending = undefined;

        throw error;
      });

      return pending;
    },

    forget: () => {
      pending = undefined;
    },
  };
};
