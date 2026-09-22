import type { WidgetConfigResponse } from '@catalogorosso/api-client';
import { describe, expect, it, vi } from 'vitest';

import { CONFIG_PATH, MAX_ATTEMPTS, readConfig } from '../src/bootstrap.js';

/**
 * What the widget learns before it loads anything (P3-03, §1.2).
 *
 * **The assertion this row exists for is an absence.** A `DISABLED` tenant must
 * cost nothing: no main bundle, no session, no model call. "Nothing" cannot be
 * asserted by looking at what happened, only by counting what did not — so the
 * fetch is a spy and its call count is the test.
 */

const config = (over: Partial<WidgetConfigResponse> = {}): WidgetConfigResponse => ({
  status: 'ACTIVE',
  locale: 'it',
  theme: { primaryColor: '#7b1e3c', position: 'bottom-right', avatarUrl: null },
  welcomeMessage: 'Posso consigliarle un vino?',
  cartUrl: 'https://cantina-rossi.example/cart',
  quotaState: 'ok',
  ...over,
});

const answering = (...responses: readonly Response[]) => {
  const calls: { url: string; init: RequestInit | undefined }[] = [];
  let at = 0;

  /*
   * Typed to what `readConfig` actually passes — a string — rather than to
   * `fetch`'s whole union, and cast once at the end. A `Request` has no useful
   * stringification, so accepting one here would be a signature promising
   * something this fake cannot do.
   */
  const fetch_ = vi.fn((url: string, init?: RequestInit) => {
    calls.push({ url, init });

    const response = responses[Math.min(at, responses.length - 1)];

    at += 1;

    return response === undefined
      ? Promise.reject(new Error('network down'))
      : Promise.resolve(response);
  });

  return { calls, fetch: fetch_ as unknown as typeof globalThis.fetch };
};

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const read = (fetch_: typeof globalThis.fetch, over: Record<string, unknown> = {}) =>
  readConfig({
    api: 'https://api.example',
    key: 'pk_test_abc',
    fetch: fetch_,
    sleep: () => Promise.resolve(),
    ...over,
  });

describe('a tenant who switched the widget off', () => {
  it('is reported as disabled', async () => {
    const { fetch } = answering(json(config({ status: 'DISABLED' })));

    await expect(read(fetch)).resolves.toMatchObject({ kind: 'disabled' });
  });

  it('costs exactly one request and nothing else', async () => {
    /*
     * **The whole point of the row, and it can only be checked as an absence.**
     * A seller who switched their widget off is often a seller thinking about
     * cancelling; a switched-off widget that still spends money is the worst
     * possible answer to that.
     */
    const { calls, fetch } = answering(json(config({ status: 'DISABLED' })));

    await read(fetch);

    expect(calls).toHaveLength(1);
    expect(calls[0]?.url).toContain(CONFIG_PATH);
  });

  it('still carries the config, so the disabled notice can be the seller own words', async () => {
    const { fetch } = answering(json(config({ status: 'DISABLED', locale: 'en' })));
    const state = await read(fetch);

    expect(state.kind === 'disabled' && state.config.locale).toBe('en');
  });
});

describe('a tenant who is serving', () => {
  it('is reported as active, with the configuration', async () => {
    const { fetch } = answering(json(config({ welcomeMessage: 'Ciao!' })));
    const state = await read(fetch);

    expect(state.kind).toBe('active');
    expect(state.kind === 'active' && state.config.welcomeMessage).toBe('Ciao!');
  });

  it('asks for the key the seller pasted', async () => {
    const { calls, fetch } = answering(json(config()));

    await read(fetch);

    expect(calls[0]?.url).toContain('key=pk_test_abc');
  });

  it('sends no cookies, because this surface accepts none', async () => {
    // P2-08 sets `Access-Control-Allow-Credentials: false`, so a credentialed
    // request is one the browser refuses for a reason nobody would guess.
    const { calls, fetch } = answering(json(config()));

    await read(fetch);

    expect(calls[0]?.init?.credentials).toBe('omit');
  });
});

describe('a refusal', () => {
  it('reports an error rather than crashing', async () => {
    const { fetch } = answering(json({ error: { code: 'forbidden' } }, 403));

    await expect(read(fetch)).resolves.toEqual({ kind: 'error' });
  });

  it('is not retried, because it will refuse the same way next time', async () => {
    /*
     * A 403 is the key and the Origin disagreeing — a seller's setup mistake,
     * and a setup mistake on the fourth attempt too. Retrying turns one refused
     * request into four, and each is counted against the tenant.
     */
    const { calls, fetch } = answering(json({}, 403));

    await read(fetch);

    expect(calls).toHaveLength(1);
  });

  it('does not retry a rate limit either', async () => {
    const { calls, fetch } = answering(json({}, 429));

    await read(fetch);

    expect(calls).toHaveLength(1);
  });
});

describe('a network that is not there', () => {
  it('retries, and gives up after a bounded number of attempts', async () => {
    // Bounded, because a visitor is looking at the page and an unbounded retry
    // is a loop running on a seller's storefront for as long as the tab is open.
    const { calls, fetch } = answering();

    await expect(read(fetch)).resolves.toEqual({ kind: 'error' });
    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });

  it('backs off, and further each time', async () => {
    const waits: number[] = [];
    const { fetch } = answering();

    await read(fetch, {
      sleep: (ms: number) => {
        waits.push(ms);

        return Promise.resolve();
      },
    });

    expect(waits).toHaveLength(MAX_ATTEMPTS - 1);
    expect(waits[1]).toBeGreaterThan(waits[0] ?? 0);
  });

  it('succeeds on a later attempt if the network comes back', async () => {
    const { calls, fetch } = answering(json({}, 503), json(config()));

    await expect(read(fetch)).resolves.toMatchObject({ kind: 'active' });
    expect(calls).toHaveLength(2);
  });

  it('retries a server error, unlike a refusal', async () => {
    // A 5xx is ours and may well be transient; a 4xx is the caller's and is not.
    const { calls, fetch } = answering(json({}, 500));

    await read(fetch);

    expect(calls).toHaveLength(MAX_ATTEMPTS);
  });
});

describe('what it stores', () => {
  it('keeps the config in memory and nowhere else', async () => {
    /*
     * No `localStorage`, no cookie. It is a per-page fact that is edge-cached
     * for a minute anyway, and putting it on a visitor's device is a tracking
     * decision nobody made (§3.4).
     */
    const { fetch } = answering(json(config()));

    await read(fetch);

    expect(globalThis.localStorage.length).toBe(0);
    expect(document.cookie).toBe('');
  });
});
