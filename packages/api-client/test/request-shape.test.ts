import { describe, expect, it, vi } from 'vitest';

import {
  createClient,
  type DashboardEndpoint,
  type PathParam,
  type RequestOptions,
} from '../src/index.js';

/**
 * What a call puts on the wire (P1-10a).
 *
 * Until now `request` took an endpoint key and nothing else, so five of the
 * fourteen endpoints — every one with a `:id` in its path — **could not be
 * called at all**, and neither could any filtered list. This is the part of the
 * client that decides what the server actually receives.
 *
 * Three of the assertions here are about values that would produce a *plausible
 * wrong answer* rather than an error: a `:id` sent literally, an `undefined`
 * serialised into a filter, an unencoded slash changing which route matches.
 * None of them throws on its own; each looks like the server behaving oddly.
 */

const capturing = (activeTenantId?: string) => {
  const calls: { url: string; init: RequestInit }[] = [];

  const fetch = vi.fn((url: string | URL, init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });

    return Promise.resolve(
      new Response(JSON.stringify({ ok: true, surface: 'dashboard' }), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      }),
    );
  });

  const client = createClient({
    baseUrl: 'https://api.test',
    ...(activeTenantId === undefined ? {} : { activeTenantId }),
    fetch: fetch as unknown as typeof globalThis.fetch,
  });

  /*
   * The response is deliberately not a valid one for any particular endpoint,
   * and `request` parses what it receives — correctly, since that is what
   * catches a server whose shape drifted. These tests are about what goes
   * *out*, so a parse failure after the call is not the subject and is
   * swallowed. Anything thrown *before* `fetch` still surfaces, which is what
   * the missing-parameter case below relies on.
   */
  const send = async <E extends DashboardEndpoint>(
    endpoint: E,
    ...init: [PathParam<E>] extends [never]
      ? [options?: RequestOptions<E>]
      : [options: RequestOptions<E>]
  ): Promise<void> => {
    try {
      await client.request(endpoint, ...init);
    } catch {
      if (calls.length === 0) throw new Error('the call never reached fetch');
    }
  };

  return { calls, client, send };
};

const headersOf = (init: RequestInit): Record<string, string> =>
  (init.headers ?? {}) as Record<string, string>;

describe('the path', () => {
  it('fills a :id segment', async () => {
    const { calls, send } = capturing();

    await send('DELETE /v1/dashboard/products/:id', { params: { id: 'abc' } });

    expect(calls[0]?.url).toBe('https://api.test/v1/dashboard/products/abc');
  });

  it('encodes a value that would otherwise change the route', async () => {
    /*
     * **Not cosmetic.** A SKU or id containing a slash sent raw adds a path
     * segment: `/products/a/b` is a different route, and the answer is a 404
     * about a product that exists — or, on a less careful server, a match on
     * something else entirely.
     */
    const { calls, send } = capturing();

    await send('DELETE /v1/dashboard/products/:id', { params: { id: 'a/b?c' } });

    expect(calls[0]?.url).toBe('https://api.test/v1/dashboard/products/a%2Fb%3Fc');
  });

  it('refuses to send a segment it was given nothing for', async () => {
    /*
     * The type makes `params` required when the path has one, so this is the
     * runtime half: a value that was `undefined` anyway. Sending `/products/:id`
     * literally is a 404 with nothing connecting it to the value somebody
     * forgot — the error names the parameter instead.
     */
    const { calls, client } = capturing();

    await expect(
      client.request('DELETE /v1/dashboard/products/:id', {
        params: { id: undefined as unknown as string },
      }),
    ).rejects.toThrow(/needs a "id"/);

    expect(calls).toHaveLength(0);
  });

  it('leaves a path with no segments alone', async () => {
    const { calls, send } = capturing();

    await send('GET /v1/dashboard/me');

    expect(calls[0]?.url).toBe('https://api.test/v1/dashboard/me');
  });
});

describe('the query string', () => {
  it('sends what it was given', async () => {
    const { calls, send } = capturing();

    await send('GET /v1/dashboard/products', {
      query: { q: 'barolo', limit: 25, includeArchived: false },
    });

    expect(calls[0]?.url).toBe(
      'https://api.test/v1/dashboard/products?q=barolo&limit=25&includeArchived=false',
    );
  });

  it('drops an undefined rather than serialising it', async () => {
    /*
     * **The bug this exists to prevent.** `?q=undefined` is a filter the server
     * will honour, and it matches nothing — so the seller sees an empty
     * catalogue that looks exactly like an empty catalogue. Every optional
     * filter on the list screen is one of these.
     */
    const { calls, send } = capturing();

    await send('GET /v1/dashboard/products', {
      query: { q: undefined, wineType: 'red', priceMin: undefined },
    });

    expect(calls[0]?.url).toBe('https://api.test/v1/dashboard/products?wineType=red');
  });

  it('adds nothing when every filter is absent', async () => {
    // A bare `?` is harmless and it is also noise in every log and cache key.
    const { calls, send } = capturing();

    await send('GET /v1/dashboard/products', { query: { q: undefined } });

    expect(calls[0]?.url).toBe('https://api.test/v1/dashboard/products');
  });

  it('encodes a value a seller could type', async () => {
    // "pét-nat & co" is a real wine type and a real search. Unencoded, the `&`
    // silently becomes a second parameter.
    const { calls, send } = capturing();

    await send('GET /v1/dashboard/products', { query: { q: 'pét-nat & co' } });

    expect(calls[0]?.url).toContain('q=p%C3%A9t-nat+%26+co');
  });
});

describe('the body', () => {
  it('is sent as JSON, with the header that makes the server parse it', async () => {
    const { calls, send } = capturing();

    await send('POST /v1/dashboard/products', { body: { sku: 'BAR-2019' } });

    expect(calls[0]?.init.body).toBe('{"sku":"BAR-2019"}');
    expect(headersOf(calls[0]?.init ?? {})['content-type']).toBe('application/json');
  });

  it('sends no content-type when there is no body', async () => {
    /*
     * A `content-type: application/json` on a GET buys nothing and is the kind
     * of header a CORS preflight or a caching proxy treats differently — an
     * extra round trip for a request that carries no content.
     */
    const { calls, send } = capturing();

    await send('GET /v1/dashboard/me');

    expect(headersOf(calls[0]?.init ?? {})['content-type']).toBeUndefined();
  });

  it('keeps the active-tenant header alongside a body', async () => {
    // Both are headers, and an earlier shape of this code set one by replacing
    // the object — so adding a body silently dropped the tenant selection.
    const { calls, send } = capturing('tenant-1');

    await send('POST /v1/dashboard/products', { body: { sku: 'X' } });

    const init = calls[0]?.init ?? {};

    expect(headersOf(init)['x-active-tenant']).toBe('tenant-1');
    expect(headersOf(init)['content-type']).toBe('application/json');
  });
});
