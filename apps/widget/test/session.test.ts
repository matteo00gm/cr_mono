import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  anonId,
  ANON_ID_KEY,
  createSession,
  expiryOf,
  REFRESH_MARGIN_MS,
  SESSION_PATH,
  SessionRefused,
} from '../src/session.js';

/**
 * The visitor's session (P3-16).
 *
 * **The assertion this file exists for is an absence**, and it is written as
 * one: after minting, neither storage holds the token. That is checked against
 * every key rather than the one we would have used, because the failure this
 * guards against is somebody adding a *convenience* — "persist the token so a
 * reload does not re-mint" — which is a token readable by any XSS anywhere on a
 * seller's storefront, a page we do not control.
 *
 * The second is that storage is allowed to not work. A sandboxed iframe throws
 * on the `sessionStorage` *getter*, before any method is called, and an
 * exception here would break the widget entirely for the visitors most likely
 * to have locked their browser down.
 */

const API = 'https://api.example';
const KEY = 'pk_test_abc';

/**
 * A token shaped the way a real one is, built at runtime.
 *
 * Never written down: a token-shaped literal is found by the P0-08 history scan
 * and cannot be edited out once pushed (P0-56). The payload carries a real
 * `exp`, because P3-21 reads it — a fixture without one is a fixture that
 * exercises the "cannot read the expiry" branch and nothing else.
 */
const tokenFor = (secondsFromNow = 900): string => {
  const claims = {
    sid: globalThis.crypto.randomUUID(),
    exp: Math.floor(Date.now() / 1000) + secondsFromNow,
  };
  const payload = globalThis
    .btoa(JSON.stringify(claims))
    .replaceAll('+', '-')
    .replaceAll('/', '_')
    .replace(/=+$/u, '');

  return ['header', payload, globalThis.crypto.randomUUID()].join('.');
};

const minting = (token: string) =>
  vi.fn<typeof globalThis.fetch>(() =>
    Promise.resolve(
      new Response(JSON.stringify({ token, expiresAt: '2026-09-23T12:00:00.000Z' }), {
        headers: { 'content-type': 'application/json' },
      }),
    ),
  );

const session = (fetch_: ReturnType<typeof minting>) =>
  createSession({ api: API, key: KEY, fetch: fetch_ });

/** Every value in a storage, whatever the keys are called. */
const contentsOf = (storage: Storage): string[] =>
  Array.from({ length: storage.length }, (_unused, index) => storage.key(index))
    .filter((key): key is string => key !== null)
    .map((key) => storage.getItem(key) ?? '');

beforeEach(() => {
  globalThis.sessionStorage.clear();
  globalThis.localStorage.clear();
  document.cookie = '';
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('minting', () => {
  it('asks the session endpoint for a token', async () => {
    const token = tokenFor();
    const fetch_ = minting(token);

    expect(await session(fetch_).token()).toBe(token);
    expect(fetch_.mock.calls[0]?.[0]).toBe(`${API}${SESSION_PATH}?key=${KEY}`);
  });

  it('sends no cookies, because this surface refuses them', async () => {
    const fetch_ = minting(tokenFor());

    await session(fetch_).token();

    expect(fetch_.mock.calls[0]?.[1]?.credentials).toBe('omit');
  });

  it('mints once for a page, however many questions are asked', async () => {
    const fetch_ = minting(tokenFor());
    const live = session(fetch_);

    await live.token();
    await live.token();

    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it('mints once for two callers who arrive before the first request returns', async () => {
    /*
     * The promise is cached, not the token — the case a resolved-value cache
     * misses, and the common one for a visitor who opens the panel and types
     * straight away. Same reasoning as P3-04's module cache.
     */
    const fetch_ = minting(tokenFor());
    const live = session(fetch_);

    await Promise.all([live.token(), live.token()]);

    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it('does not cache a failure, so the next question tries again', async () => {
    const token = tokenFor();
    const fetch_ = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('', { status: 503 }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ token, expiresAt: '2026-09-23T12:00:00.000Z' }), {
          headers: { 'content-type': 'application/json' },
        }),
      );
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await expect(live.token()).rejects.toThrow('503');

    expect(await live.token()).toBe(token);
  });

  it('mints again after being told to forget, which is how P3-21 refreshes', async () => {
    const fetch_ = minting(tokenFor());
    const live = session(fetch_);

    await live.token();
    live.forget();
    await live.token();

    expect(fetch_).toHaveBeenCalledTimes(2);
  });
});

describe('where the token is not', () => {
  it('is in neither storage after minting', async () => {
    /*
     * **The row's own test, and it is written as an absence on purpose.** Not
     * "the key we would have used is empty" — no value anywhere in either
     * storage is the token, whatever somebody decided to call it.
     */
    const token = tokenFor();

    await session(minting(token)).token();

    expect(contentsOf(globalThis.sessionStorage)).not.toContain(token);
    expect(contentsOf(globalThis.localStorage)).not.toContain(token);
  });

  it('is not in a cookie either', async () => {
    const token = tokenFor();

    await session(minting(token)).token();

    expect(document.cookie).not.toContain(token);
  });

  it('writes nothing at all to localStorage', async () => {
    await session(minting(tokenFor())).token();

    expect(globalThis.localStorage.length).toBe(0);
  });
});

describe('the anonymous id', () => {
  it('survives a reload within the tab', () => {
    const first = anonId();

    /* A reload is a fresh module and the same `sessionStorage`. */
    expect(globalThis.sessionStorage.getItem(ANON_ID_KEY)).toBe(first);
    expect(anonId()).toBe(first);
  });

  it('is not the token, and is not worth stealing', async () => {
    const token = tokenFor();

    await session(minting(token)).token();

    expect(anonId()).not.toBe(token);
  });

  it('is a fresh id for a tab that has none', () => {
    const first = anonId();

    globalThis.sessionStorage.clear();

    expect(anonId()).not.toBe(first);
  });

  it('replaces an empty value rather than handing one out', () => {
    globalThis.sessionStorage.setItem(ANON_ID_KEY, '');

    expect(anonId()).not.toBe('');
  });

  it('still works when storage throws on read', () => {
    /*
     * A sandboxed iframe throws on the getter itself. The widget must not care:
     * the id simply does not survive a reload, which costs continuity and not
     * the chat.
     */
    vi.stubGlobal('sessionStorage', {
      getItem: () => {
        throw new Error('The operation is insecure.');
      },
      setItem: () => {
        throw new Error('The operation is insecure.');
      },
      length: 0,
      key: () => null,
      clear: () => undefined,
      removeItem: () => undefined,
    });

    expect(() => anonId()).not.toThrow();
    expect(anonId()).not.toBe('');
    /* And it is the *same* id twice: one visitor, one page, one id. */
    expect(anonId()).toBe(anonId());
  });

  it('does not go on handing out an id another script has cleared', () => {
    /*
     * A seller's own script calling `sessionStorage.clear()` is not a browser
     * refusing storage, and treating it as one would keep an id alive that is
     * no longer written down anywhere.
     */
    const first = anonId();

    globalThis.sessionStorage.clear();

    const second = anonId();

    expect(second).not.toBe(first);
    expect(globalThis.sessionStorage.getItem(ANON_ID_KEY)).toBe(second);
  });
});

/** One minted response, for a test that wants to script a sequence of them. */
const respond = (token: string): Response =>
  new Response(JSON.stringify({ token, expiresAt: '2026-09-25T12:00:00.000Z' }), {
    headers: { 'content-type': 'application/json' },
  });

describe('reading when a token expires', () => {
  /*
   * **Decoded, never verified** (P3-21). The signature is the server's business
   * and the key to check it is deliberately not in the widget; the client needs
   * one number, and reading it wrong costs a refresh it did not need rather
   * than a security hole.
   */
  it('reads exp, in milliseconds', () => {
    const at = expiryOf(tokenFor(900));

    expect(at).toBeGreaterThan(Date.now());
    expect(at).toBeLessThan(Date.now() + 901_000);
  });

  it('says nothing about a token it cannot read', () => {
    /* Which the caller treats as "refresh now" — the safe direction. */
    expect(expiryOf('not-a-token')).toBeUndefined();
    expect(expiryOf('a.b.c')).toBeUndefined();
    expect(expiryOf('')).toBeUndefined();
  });

  it('reads a payload in base64url, which is not what atob takes', () => {
    /*
     * **The payload has to be one that needs it.** The two alphabets differ by
     * two characters, so a fixture whose base64 happens to contain neither
     * passes a decoder that never converts them — which is what every earlier
     * fixture here did, and what let a mutation of the conversion survive.
     *
     * `sid: '>'` encodes to a `+` in standard base64, so its url form carries a
     * `-` that plain `atob` rejects.
     */
    const claims = { sid: '>', exp: 1_800_000_000 };
    const payload = globalThis
      .btoa(JSON.stringify(claims))
      .replaceAll('+', '-')
      .replaceAll('/', '_')
      .replace(/=+$/u, '');

    expect(payload).toMatch(/[-_]/u);
    expect(expiryOf(`header.${payload}.signature`)).toBe(1_800_000_000_000);
  });

  it('says nothing when the payload carries no exp at all', () => {
    const payload = globalThis.btoa(JSON.stringify({ sid: 'x' })).replace(/=+$/u, '');

    expect(expiryOf(`h.${payload}.s`)).toBeUndefined();
  });
});

describe('refreshing before a visitor notices', () => {
  it('reuses a token that is good for a while yet', async () => {
    const fetch_ = minting(tokenFor(900));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    await live.token();

    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it('refreshes one inside the margin, before it is used', async () => {
    /*
     * The race this prevents: a token that passes the check and expires in the
     * seconds before the server reads it produces a 401 on a request a visitor
     * is watching.
     */
    const fetch_ = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(respond(tokenFor(30)))
      .mockResolvedValueOnce(respond(tokenFor(900)));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    await live.token();

    expect(fetch_).toHaveBeenCalledTimes(2);
  });

  it('treats a token it cannot read as already expired', async () => {
    const fetch_ = minting('not-a-token');
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    await live.token();

    expect(fetch_).toHaveBeenCalledTimes(2);
  });

  it('holds the margin at a minute', () => {
    expect(REFRESH_MARGIN_MS).toBe(60_000);
  });

  it('counts the margin against the clock it was given', async () => {
    const token = tokenFor(120);
    const fetch_ = minting(token);
    const expiry = expiryOf(token) ?? 0;
    const live = createSession({
      api: API,
      key: KEY,
      fetch: fetch_,
      /* Thirty seconds before expiry, which is inside the margin. */
      now: () => expiry - 30_000,
    });

    await live.token();
    await live.token();

    expect(fetch_).toHaveBeenCalledTimes(2);
  });

  it('mints once for five sends in the same tick', async () => {
    /*
     * **Single-flight, and the promise is what is cached.** A burst that minted
     * five sessions would race to overwrite the token, and four of the five
     * conversations would be recorded against a session id nobody kept.
     */
    const fetch_ = minting(tokenFor(900));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await Promise.all([live.token(), live.token(), live.token(), live.token(), live.token()]);

    expect(fetch_).toHaveBeenCalledTimes(1);
  });

  it('shares one refresh between concurrent callers too', async () => {
    const fetch_ = minting(tokenFor(900));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    await Promise.all([live.refresh(), live.refresh(), live.refresh()]);

    expect(fetch_).toHaveBeenCalledTimes(2);
  });

  it('does not hand back a token the server has just rejected', async () => {
    /*
     * A refresh that fails leaves nothing held, so the next question mints
     * rather than presenting the token that caused the 401 all over again —
     * which would be a loop with extra steps.
     */
    const first = tokenFor(900);
    const replacement = tokenFor(900);
    const fetch_ = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(respond(first))
      .mockResolvedValueOnce(new Response('{}', { status: 401 }))
      .mockResolvedValueOnce(respond(replacement));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    await expect(live.refresh()).rejects.toBeInstanceOf(SessionRefused);

    expect(await live.token()).toBe(replacement);
  });

  it('mints again after a refresh, rather than handing back the old token', async () => {
    const first = tokenFor(900);
    const second = tokenFor(900);
    const fetch_ = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(respond(first))
      .mockResolvedValueOnce(respond(second));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    expect(await live.token()).toBe(first);
    expect(await live.refresh()).toBe(second);
    expect(await live.token()).toBe(second);
  });
});

describe('continuing the same conversation', () => {
  const authOf = (fetch_: ReturnType<typeof minting>, call: number): string | undefined =>
    (fetch_.mock.calls[call]?.[1]?.headers as Record<string, string> | undefined)?.authorization;

  it('sends the previous token, so the session id survives a refresh', async () => {
    /*
     * P2-12a. Without it a refresh starts a new session id, and the
     * conversation the server has been recording stops being the same
     * conversation halfway through a visitor's sentence.
     */
    const first = tokenFor(900);
    const fetch_ = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(respond(first))
      .mockResolvedValueOnce(respond(tokenFor(900)));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    await live.refresh();

    expect(
      (fetch_.mock.calls[1]?.[1]?.headers as Record<string, string> | undefined)?.authorization,
    ).toBe(`Bearer ${first}`);
  });

  it('sends none on the first mint, because there is nothing to continue', async () => {
    const fetch_ = minting(tokenFor(900));

    await createSession({ api: API, key: KEY, fetch: fetch_ }).token();

    expect(authOf(fetch_, 0)).toBeUndefined();
  });

  it('sends none after forgetting, which is a fresh session by intent', async () => {
    const fetch_ = minting(tokenFor(900));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await live.token();
    live.forget();
    await live.token();

    expect(authOf(fetch_, 1)).toBeUndefined();
  });
});

describe('a refusal the widget has to tell apart', () => {
  const refusing = (status: number, body: string, json = true) =>
    vi.fn<typeof globalThis.fetch>().mockResolvedValue(
      new Response(body, {
        status,
        ...(json ? { headers: { 'content-type': 'application/json' } } : {}),
      }),
    );

  it('carries the status', async () => {
    await expect(
      createSession({ api: API, key: KEY, fetch: refusing(429, '{}') }).token(),
    ).rejects.toBeInstanceOf(SessionRefused);
  });

  it('carries the code, which is how a lapsed winery is told from a broken one', async () => {
    /*
     * Section 1.3: a lapsed subscription renders *disabled*, not an error with
     * a retry button that can never succeed.
     */
    const body = JSON.stringify({ error: { code: 'unavailable', message: 'Not available' } });

    await expect(
      createSession({ api: API, key: KEY, fetch: refusing(403, body) }).token(),
    ).rejects.toMatchObject({ status: 403, code: 'unavailable' });
  });

  it('survives a refusal that is not our shape at all', async () => {
    await expect(
      createSession({
        api: API,
        key: KEY,
        fetch: refusing(502, '<html>502</html>', false),
      }).token(),
    ).rejects.toMatchObject({ status: 502, code: undefined });
  });

  it('does not cache the failure, so the next question tries again', async () => {
    const token = tokenFor(900);
    const fetch_ = vi
      .fn<typeof globalThis.fetch>()
      .mockResolvedValueOnce(new Response('{}', { status: 503 }))
      .mockResolvedValueOnce(respond(token));
    const live = createSession({ api: API, key: KEY, fetch: fetch_ });

    await expect(live.token()).rejects.toBeInstanceOf(SessionRefused);

    expect(await live.token()).toBe(token);
  });
});
