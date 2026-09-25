import { describe, expect, it } from 'vitest';

import { GuardedFetchRefused, type GuardedResponse } from '../src/net/guarded-fetch.js';
import {
  probeOrigin,
  verifyWellKnownFile,
  wellKnownPath,
  type Fetcher,
} from '../src/net/verify-wellknown.js';

/**
 * Proving control of a domain by serving a file (P4-03, §3.3).
 *
 * **The SSRF constraints are not tested here, deliberately.** They live in
 * `guardedFetch` and are asserted against it in `guarded-fetch.test.ts` — the
 * rebinding simulation, the refused redirect, the capped body, the port and
 * scheme. Re-asserting them through this module would test the same code twice
 * and leave the impression there are two defences when there is one.
 *
 * What is asserted here is the part that is this row's: that the request goes
 * through the guarded agent at all, that the nonce is in the path, and that a
 * refusal tells a seller enough to act without telling a caller which addresses
 * our network will not reach.
 */

/** Built at runtime, never written into the file (P0-56). */
const nonce = (): string =>
  Array.from({ length: 64 }, () => '0123456789abcdef'[Math.floor(Math.random() * 16)]).join('');

const serving = (body: string, status = 200): { fetcher: Fetcher; urls: string[] } => {
  const urls: string[] = [];
  const fetcher = ((url: string): Promise<GuardedResponse> => {
    urls.push(url);

    return Promise.resolve({ status, body });
  }) as Fetcher;

  return { fetcher, urls };
};

/* A fetcher that always fails. `unknown` on purpose: nothing guarantees a
 * rejection is an `Error`, and one of the cases below is exactly that. */
const refusing =
  (error: unknown): Fetcher =>
  () =>
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the case
    Promise.reject(error);

describe('the URL it asks for', () => {
  it('carries the nonce in the path, not only in the file', async () => {
    /*
     * **The path is itself unguessable**, which is half the proof. A host that
     * serves the right bytes at a path nobody told them about has proved
     * nothing; one that serves anything at all at this path has.
     */
    const token = nonce();
    const { fetcher, urls } = serving(token);

    await verifyWellKnownFile('winery.com', token, fetcher);

    expect(urls).toEqual([`https://winery.com/.well-known/somm-verify-${token}.txt`]);
  });

  it('asks the registrable domain over https', async () => {
    const token = nonce();
    const { fetcher, urls } = serving(token);

    await verifyWellKnownFile('winery.com', token, fetcher);

    expect(urls[0]).toMatch(/^https:\/\/winery\.com\//u);
  });

  it('builds the path from the nonce and nothing else', () => {
    expect(wellKnownPath('abc')).toBe('/.well-known/somm-verify-abc.txt');
  });
});

describe('a domain serving the file', () => {
  it('verifies', async () => {
    const token = nonce();
    const { fetcher } = serving(token);

    await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toEqual({ ok: true });
  });

  it.each([
    ['a trailing newline', (t: string) => `${t}\n`],
    ['a trailing CRLF', (t: string) => `${t}\r\n`],
    ['leading whitespace', (t: string) => `  ${t}`],
    ['both', (t: string) => `\n ${t} \n`],
  ])('verifies with %s, which is how the file gets written', async (_name, wrap) => {
    /*
     * `echo <nonce> > file` leaves a newline and every editor adds one. A check
     * that refused it would fail for the most obvious way a seller creates this
     * file — and the failure would read to them as "your correct file is wrong".
     */
    const token = nonce();
    const { fetcher } = serving(wrap(token));

    await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toEqual({ ok: true });
  });
});

describe('a domain serving something else', () => {
  it('reports a mismatch for a value with something wrapped around it', async () => {
    /* A quoted form or a `key=value` line is a different file, and saying so
     * beats silently accepting a prefix. */
    const token = nonce();

    for (const body of [`"${token}"`, `somm=${token}`, `${token} ok`]) {
      const { fetcher } = serving(body);

      await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toMatchObject({
        ok: false,
        reason: 'mismatch',
      });
    }
  });

  it('reports a mismatch rather than matching a prefix', async () => {
    const token = nonce();
    const { fetcher } = serving(token.slice(0, 32));

    await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toMatchObject({
      reason: 'mismatch',
    });
  });

  it('reports a mismatch for a styled 200 page, which is what most hosts serve', async () => {
    /*
     * **Plenty of storefronts answer an unknown path with a 200 and a themed
     * page** rather than a 404. "We found something and it is not your value"
     * is what a seller needs to hear; "not found" would send them to check an
     * upload that is already there.
     */
    const token = nonce();
    const { fetcher } = serving('<!doctype html><title>Page not found</title>');

    await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toMatchObject({
      reason: 'mismatch',
    });
  });

  it.each([404, 410])('reports %s as a missing file', async (status) => {
    const token = nonce();
    const { fetcher } = serving('not here', status);

    await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toMatchObject({
      ok: false,
      reason: 'not_found',
    });
  });

  it.each([401, 403, 500, 502, 301])(
    'reports %s as a mismatch, not a missing file',
    async (status) => {
      /* The file may well be there behind whatever answered. Telling a seller to
       * upload it again is the wrong instruction. */
      const token = nonce();
      const { fetcher } = serving(token, status);

      await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toMatchObject({
        reason: 'mismatch',
      });
    },
  );

  it('does not accept the right body behind the wrong status', async () => {
    const token = nonce();
    const { fetcher } = serving(token, 404);

    await expect(verifyWellKnownFile('winery.com', token, fetcher)).resolves.toMatchObject({
      ok: false,
    });
  });
});

describe('a request our own defences refused', () => {
  /*
   * **What the seller is told and what we record are different on purpose.**
   * `guardedFetch`'s reasons name what our network refused and why; a caller
   * who could read them could use this endpoint to map which addresses we will
   * not reach. "We could not reach your site" is true and gives them nothing.
   */
  it.each([
    'blocked_address',
    'blocked_redirect',
    'blocked_scheme',
    'blocked_port',
    'dns_failure',
    'timeout',
    'too_large',
    'network',
  ] as const)('tells the seller one thing for %s', async (reason) => {
    const result = await verifyWellKnownFile(
      'winery.com',
      nonce(),
      refusing(new GuardedFetchRefused(reason)),
    );

    expect(result).toMatchObject({ ok: false, reason: 'unreachable' });
  });

  it('keeps the precise reason for our own logs', async () => {
    const result = await verifyWellKnownFile(
      'winery.com',
      nonce(),
      refusing(new GuardedFetchRefused('blocked_address')),
    );

    expect(result).toMatchObject({ ok: false, detail: 'blocked_address' });
  });

  it('records a failure that is not one of ours as a network failure', async () => {
    const result = await verifyWellKnownFile(
      'winery.com',
      nonce(),
      refusing(new Error('ECONNRESET')),
    );

    expect(result).toMatchObject({ ok: false, reason: 'unreachable', detail: 'network' });
  });

  it('survives a rejection that is not an Error at all', async () => {
    const result = await verifyWellKnownFile('winery.com', nonce(), refusing(null));

    expect(result).toMatchObject({ reason: 'unreachable', detail: 'network' });
  });
});

describe('the client it uses when nobody supplies one', () => {
  it('is the guarded one, so every SSRF constraint applies unasked', async () => {
    /*
     * **The assertion this file most needs.** Every other case injects a
     * fetcher, so a version that reached for plain `fetch` would pass all of
     * them — and plain `fetch` follows redirects, resolves twice, and has no
     * cap or timeout. `http:` is refused before a socket is opened, which is
     * `guardedFetch`'s own behaviour and nothing else's.
     */
    /*
     * `a..b` has an empty label, which `getaddrinfo` rejects itself in about a
     * millisecond and without touching a network. A real-looking domain here
     * would be a live HTTPS request from CI the day it happened to resolve —
     * which is the shape of test that passes on a laptop and fails in a
     * pipeline.
     */
    const result = await verifyWellKnownFile('a..b', nonce());

    /* A guarded client refuses at the lookup. Plain `fetch` would have thrown
     * something that is not a `GuardedFetchRefused`, and `detail` would read
     * `network` instead. */
    expect(result).toMatchObject({ ok: false, reason: 'unreachable', detail: 'dns_failure' });
  });
});

describe('probing whether a host answers (P4-05)', () => {
  it('asks the root with HEAD, not GET', async () => {
    /* A liveness question, not a read. A GET would pull a whole homepage
     * through the body cap for an answer that is in the status line. */
    const seen: { url: string; method?: string }[] = [];
    const fetcher = ((url: string, options?: { method?: string }) => {
      seen.push({ url, ...(options?.method === undefined ? {} : { method: options.method }) });

      return Promise.resolve({ status: 200, body: '' });
    }) as Fetcher;

    await probeOrigin('https://winery.com', fetcher);

    expect(seen).toEqual([{ url: 'https://winery.com/', method: 'HEAD' }]);
  });

  it('counts any answer, including a 404', async () => {
    /*
     * The question is whether a widget loaded on that origin would reach a live
     * host, not whether the root path happens to be a page. Plenty of
     * storefronts answer `/` with a redirect or a 403 and serve everything else
     * perfectly.
     */
    for (const status of [200, 301, 403, 404, 500]) {
      const fetcher = (() => Promise.resolve({ status, body: '' })) as Fetcher;

      await expect(probeOrigin('https://winery.com', fetcher)).resolves.toBe(true);
    }
  });

  it('reports a host that does not answer, without throwing', async () => {
    /*
     * **The swallow is the contract.** A probe is advice on a screen — "www
     * does not respond, remove it?" — and a host that is down for the minute
     * somebody pressed verify must not fail the verification it hangs off.
     */
    await expect(
      probeOrigin('https://winery.com', refusing(new Error('ECONNREFUSED'))),
    ).resolves.toBe(false);
  });

  it('reports a refusal by our own agent as no answer', async () => {
    await expect(
      probeOrigin('https://winery.com', refusing(new GuardedFetchRefused('blocked_address'))),
    ).resolves.toBe(false);
  });

  it('goes through the guarded agent when nobody supplies one', async () => {
    /*
     * **A probe is an equally attacker-chosen host and gets no exemption.** A
     * "just a quick HEAD" helper written beside this one would be the hole —
     * which is exactly why this lives here rather than in the port.
     *
     * A probe returns a boolean, so it cannot report *which* client refused:
     * an unguarded one would look identical from out here. What makes this
     * assertable is that both functions share one `DEFAULT_FETCHER`, so the
     * case above — which can tell them apart, because it reads `detail` —
     * proves this one too.
     */
    await expect(probeOrigin('https://a..b')).resolves.toBe(false);
  });
});
