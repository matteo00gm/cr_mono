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
  /** Injected so a test can reach an expiry without waiting fifteen minutes. */
  readonly now?: (() => number) | undefined;
}

/**
 * A refusal from the session endpoint, carrying what it refused with.
 *
 * **The code is the whole reason this is a class.** A winery that has lapsed
 * answers `unavailable`, and §1.3 says the widget renders *disabled* for that
 * and *error* for everything else — a lapsed subscription that looks like a
 * broken widget is a support ticket instead of an invoice (P3-21).
 */
export class SessionRefused extends Error {
  constructor(
    readonly status: number,
    readonly code?: string,
  ) {
    super(`The session endpoint refused with ${String(status)}.`);
    this.name = 'SessionRefused';
  }
}

/** The `error.code` a refusal carried, read defensively: a 502 is not our shape. */
const codeIn = async (response: Response): Promise<string | undefined> => {
  try {
    const body = (await response.json()) as { error?: { code?: unknown } };

    return typeof body.error?.code === 'string' ? body.error.code : undefined;
  } catch {
    return undefined;
  }
};

export interface Session {
  /**
   * A token good for the next minute at least, minting or refreshing as needed.
   *
   * Concurrent callers share one request — five sends in a burst trigger one
   * mint, not five (P3-21).
   */
  readonly token: () => Promise<string>;
  /**
   * Throws the current token away and gets another.
   *
   * What a `401` calls: the server has decided this token is no good, and no
   * amount of looking at its `exp` would have told us.
   */
  readonly refresh: () => Promise<string>;
  /** Drops the token without minting. For a test, and for a panel going away. */
  readonly forget: () => void;
}

/**
 * How long before expiry a token is treated as already expired.
 *
 * A minute, because the alternative is a race nobody can debug: a token that
 * passes the check and expires in the seconds between the check and the
 * server reading it produces a `401` on a request a visitor is watching. The
 * reactive path would recover it — this is what stops it happening at all.
 */
export const REFRESH_MARGIN_MS = 60_000;

/**
 * When a token stops being valid, or nothing.
 *
 * **Decoded, never verified.** The signature is the server's business and the
 * key to check it is deliberately not here; the client needs one number, and
 * reading it wrong costs a refresh it did not need rather than a security
 * hole. A token we cannot read at all reads as "refresh now", which is the
 * safe direction.
 */
export const expiryOf = (token: string): number | undefined => {
  const payload = token.split('.')[1];

  if (payload === undefined) return undefined;

  try {
    /* base64url, which `atob` does not accept: the two alphabets differ. */
    const json = globalThis.atob(payload.replaceAll('-', '+').replaceAll('_', '/'));
    const claims = JSON.parse(json) as { exp?: unknown };

    return typeof claims.exp === 'number' ? claims.exp * 1000 : undefined;
  } catch {
    return undefined;
  }
};

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
  now = () => Date.now(),
}: SessionOptions): Session => {
  /** The live token and when it stops being one. Never written anywhere durable. */
  let held: { token: string; expiresAt: number | undefined } | undefined;

  /**
   * The mint in flight, if there is one.
   *
   * **Single-flight, and the promise is what is cached.** Five sends in the
   * same tick must trigger one mint: a resolved-value cache misses exactly the
   * case that matters, where the second caller arrives before the first request
   * has come back. Same reasoning as P3-04's module cache.
   */
  let minting: Promise<string> | undefined;

  const mint = async (previous: string | undefined): Promise<string> => {
    const response = await fetch_(`${api}${SESSION_PATH}?key=${encodeURIComponent(key)}`, {
      method: 'POST',
      /* This surface accepts no cookies, and asking is how CORS fails (P2-08). */
      credentials: 'omit',
      headers: {
        accept: 'application/json',
        /*
         * **The previous token continues its session** (P2-12a). Without it a
         * refresh starts a new `sid`, and the conversation the server has been
         * recording against the old one stops being the same conversation
         * halfway through a visitor's sentence.
         */
        ...(previous === undefined ? {} : { authorization: `Bearer ${previous}` }),
      },
    });

    if (!response.ok) throw new SessionRefused(response.status, await codeIn(response));

    const session = (await response.json()) as WidgetSessionResponse;

    held = { token: session.token, expiresAt: expiryOf(session.token) };

    return session.token;
  };

  /**
   * Starts a mint and holds the promise.
   *
   * **The single-flight lives in the two callers, not here.** Both read
   * `minting` before doing anything and hand back what is already in flight, so
   * a `??=` in this function guarded nothing — two mechanisms for one property,
   * each hiding the other from a mutation. One of them had to go, and the
   * callers' is the one that also returns the right promise.
   */
  const start = (previous: string | undefined): Promise<string> => {
    minting = mint(previous).finally(() => {
      /*
       * Cleared whichever way it went. A cached rejection would leave a visitor
       * unable to ask anything for the rest of the page with nothing saying
       * why — the trap P3-04's loader avoids — and a cached *success* would
       * make the next expiry unrefreshable.
       */
      minting = undefined;
    });

    return minting;
  };

  return {
    token: () => {
      if (minting !== undefined) return minting;

      const current = held;

      /*
       * A token with no readable expiry is treated as expired. Refreshing one
       * that was fine costs a request; trusting one that was not costs a `401`
       * in front of a visitor.
       */
      if (current !== undefined && (current.expiresAt ?? 0) - now() > REFRESH_MARGIN_MS) {
        return Promise.resolve(current.token);
      }

      return start(current?.token);
    },

    refresh: () => {
      if (minting !== undefined) return minting;

      const previous = held?.token;

      held = undefined;

      return start(previous);
    },

    forget: () => {
      held = undefined;
      minting = undefined;
    },
  };
};
