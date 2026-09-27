import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSession } from '../src/session.js';
import {
  ChallengeFailed,
  createChallenge,
  forgetTurnstile,
  loadTurnstile,
  TURNSTILE_ACTION,
  TURNSTILE_SCRIPT,
  type TurnstileApi,
} from '../src/turnstile.js';

/**
 * The Turnstile challenge in the widget (P4-14).
 *
 * Cloudflare's script never loads here: a stand-in `turnstile` global answers
 * as the real one would. What is asserted is when anything is loaded at all,
 * what the challenge is rendered for, and that the mint carries its token.
 */

afterEach(() => {
  forgetTurnstile();
  delete (globalThis as { turnstile?: TurnstileApi }).turnstile;
  document.head.querySelectorAll('script').forEach((script) => {
    script.remove();
  });
});

const scripts = (): string[] =>
  [...document.head.querySelectorAll('script')].map((script) => script.src);

/** A Cloudflare that answers each render with `outcome`. */
const cloudflare = (outcome: 'token' | 'error' | 'expired' = 'token') => {
  const rendered: { sitekey: string; action: string; appearance: string }[] = [];
  const removed: string[] = [];
  const api: TurnstileApi = {
    render: (_container, options) => {
      rendered.push({
        sitekey: options.sitekey,
        action: options.action,
        appearance: options.appearance,
      });
      queueMicrotask(() => {
        if (outcome === 'token') options.callback(`token-${String(rendered.length)}`);
        else if (outcome === 'error') options['error-callback']();
        else options['expired-callback']();
      });
      return `widget-${String(rendered.length)}`;
    },
    remove: (id) => removed.push(id),
  };

  return { api, rendered, removed };
};

describe('loading Cloudflare’s script', () => {
  it('adds it once, however many mints ask at the same time', async () => {
    const { api } = cloudflare();
    const first = loadTurnstile(document);
    const second = loadTurnstile(document);

    (globalThis as { turnstile?: TurnstileApi }).turnstile = api;
    document.head.querySelector('script')?.dispatchEvent(new Event('load'));

    expect(await first).toBe(api);
    expect(await second).toBe(api);
    expect(scripts()).toEqual([TURNSTILE_SCRIPT]);
  });

  it('uses a Turnstile the page already has, and adds nothing', async () => {
    const { api } = cloudflare();
    (globalThis as { turnstile?: TurnstileApi }).turnstile = api;

    expect(await loadTurnstile(document)).toBe(api);
    expect(scripts()).toEqual([]);
  });

  it('tries again after a load that failed, rather than failing forever', async () => {
    const failed = loadTurnstile(document);
    document.head.querySelector('script')?.dispatchEvent(new Event('error'));

    await expect(failed).rejects.toBeInstanceOf(ChallengeFailed);

    void loadTurnstile(document).catch(() => undefined);

    expect(scripts()).toHaveLength(2);
  });

  it('refuses a script that loaded without its API', async () => {
    const loading = loadTurnstile(document);
    document.head.querySelector('script')?.dispatchEvent(new Event('load'));

    await expect(loading).rejects.toBeInstanceOf(ChallengeFailed);
  });
});

describe('the challenge', () => {
  const container = () => {
    const element = document.createElement('div');
    document.body.append(element);
    return element;
  };

  it('is rendered for this site key and for the session action, quietly', async () => {
    const { api, rendered } = cloudflare();
    const solve = createChallenge({
      siteKey: 'site-key',
      container: container(),
      load: () => Promise.resolve(api),
    });

    expect(await solve()).toBe('token-1');
    expect(rendered).toEqual([
      { sitekey: 'site-key', action: TURNSTILE_ACTION, appearance: 'interaction-only' },
    ]);
  });

  it('is solved fresh each time, since a token is good for one mint', async () => {
    const { api } = cloudflare();
    const solve = createChallenge({
      siteKey: 'site-key',
      container: container(),
      load: () => Promise.resolve(api),
    });

    expect([await solve(), await solve()]).toEqual(['token-1', 'token-2']);
  });

  it('cleans up after itself, answered or not', async () => {
    const { api, removed } = cloudflare('error');
    const box = container();
    const solve = createChallenge({
      siteKey: 'k',
      container: box,
      load: () => Promise.resolve(api),
    });

    await expect(solve()).rejects.toBeInstanceOf(ChallengeFailed);
    expect(removed).toEqual(['widget-1']);
    expect(box.childElementCount).toBe(0);
  });

  it('fails when the challenge expires unanswered', async () => {
    const { api } = cloudflare('expired');
    const solve = createChallenge({
      siteKey: 'k',
      container: container(),
      load: () => Promise.resolve(api),
    });

    await expect(solve()).rejects.toBeInstanceOf(ChallengeFailed);
  });
});

describe('the mint', () => {
  const minted = () =>
    vi.fn<typeof globalThis.fetch>(() =>
      Promise.resolve(Response.json({ token: 'a.b.c', expiresAt: '2026-09-27T12:00:00.000Z' })),
    );

  it('sends no body and loads nothing when the winery has no challenge', async () => {
    const fetch_ = minted();

    await createSession({ api: 'https://api.example', key: 'k', fetch: fetch_ }).token();

    expect(fetch_.mock.calls[0]?.[1]?.body).toBeUndefined();
    expect(scripts()).toEqual([]);
  });

  it('carries a fresh token when it has one', async () => {
    const fetch_ = minted();

    await createSession({
      api: 'https://api.example',
      key: 'k',
      fetch: fetch_,
      challenge: () => Promise.resolve('solved'),
    }).token();

    const init = fetch_.mock.calls[0]?.[1];

    expect(init?.body).toBe(JSON.stringify({ turnstileToken: 'solved' }));
    expect((init?.headers as Record<string, string>)['content-type']).toBe('application/json');
  });

  it('asks the server nothing when the challenge fails', async () => {
    const fetch_ = minted();

    await expect(
      createSession({
        api: 'https://api.example',
        key: 'k',
        fetch: fetch_,
        challenge: () => Promise.reject(new ChallengeFailed('test')),
      }).token(),
    ).rejects.toBeInstanceOf(ChallengeFailed);
    expect(fetch_).not.toHaveBeenCalled();
  });
});
