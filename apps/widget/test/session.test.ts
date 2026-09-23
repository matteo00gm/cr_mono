import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { anonId, ANON_ID_KEY, createSession, SESSION_PATH } from '../src/session.js';

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

/** Built at runtime, never written down: a token-shaped literal is P0-56's whole point. */
const tokenFor = (): string => ['h', 'p', globalThis.crypto.randomUUID()].join('.');

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
