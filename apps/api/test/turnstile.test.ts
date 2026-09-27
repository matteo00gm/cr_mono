import { randomUUID } from 'node:crypto';

import { memoryRateLimiter } from '@catalogorosso/security';
import { generateWidgetTokenKey, loadWidgetTokenKeys } from '@catalogorosso/security/tokens';
import { beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import type { WidgetDependencies } from '../src/surfaces/widget.js';
import type { WidgetResolution } from '@catalogorosso/db';
import {
  createTurnstileVerifier,
  TURNSTILE_ACTION,
  TURNSTILE_REFUSED,
  TURNSTILE_TOKEN_MAX,
  TURNSTILE_VERIFY_URL,
  type TurnstileCheck,
} from '../src/turnstile.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * Turnstile on the session mint (P4-14).
 *
 * Cloudflare is never called: the verifier is given a `fetch`, and every
 * answer Cloudflare could give is one of these stand-ins. What is tested is
 * what we do with each — and that the mint asks at all only for a winery that
 * turned the challenge on.
 */

const ORIGIN = 'https://www.winery.example';
const TOKEN = 'a-turnstile-token';

/* ---- the verifier ------------------------------------------------------- */

interface Asked {
  url: string;
  form: URLSearchParams;
}

const answering = (answer: unknown, status = 200) => {
  const asked: Asked[] = [];
  const fetch_: typeof globalThis.fetch = (input, init) => {
    asked.push({ url: input as string, form: init?.body as URLSearchParams });
    return Promise.resolve(Response.json(answer, { status }));
  };

  return { asked, verify: createTurnstileVerifier({ secret: 'the-secret', fetch: fetch_ }) };
};

const good = { success: true, hostname: 'www.winery.example', action: TURNSTILE_ACTION };
const check = (over: Partial<TurnstileCheck> = {}): TurnstileCheck => ({
  token: TOKEN,
  origin: ORIGIN,
  remoteIp: '203.0.113.7',
  ...over,
});

describe('the verifier', () => {
  it('passes a token Cloudflare accepted, for this origin and this action', async () => {
    const { asked, verify } = answering(good);

    expect(await verify(check())).toBe(true);
    expect(asked[0]?.url).toBe(TURNSTILE_VERIFY_URL);
    expect(Object.fromEntries(asked[0]?.form ?? [])).toEqual({
      secret: 'the-secret',
      response: TOKEN,
      remoteip: '203.0.113.7',
    });
  });

  it('refuses a token solved on another site that uses the same site key', async () => {
    /* Every seller's page embeds our key; the hostname is what ties a token to this one. */
    const { verify } = answering({ ...good, hostname: 'www.another-winery.example' });

    expect(await verify(check())).toBe(false);
  });

  it('refuses a token solved for another action', async () => {
    const { verify } = answering({ ...good, action: 'login' });

    expect(await verify(check())).toBe(false);
  });

  it('refuses what Cloudflare refused', async () => {
    const { verify } = answering({ ...good, success: false });

    expect(await verify(check())).toBe(false);
  });

  it.each([
    ['a non-200', () => answering(good, 500).verify],
    [
      'an unreachable Cloudflare',
      () =>
        createTurnstileVerifier({
          secret: 's',
          fetch: () => Promise.reject(new TypeError('fetch failed')),
        }),
    ],
    [
      'a body that is not JSON',
      () =>
        createTurnstileVerifier({
          secret: 's',
          fetch: () => Promise.resolve(new Response('<html>')),
        }),
    ],
  ])('fails closed on %s', async (_name, make) => {
    expect(await make()(check())).toBe(false);
  });

  it('gives up on a Cloudflare that does not answer, and refuses', async () => {
    const verify = createTurnstileVerifier({
      secret: 's',
      timeoutMs: 20,
      fetch: (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new DOMException('timed out', 'TimeoutError'));
          });
        }),
    });

    expect(await verify(check())).toBe(false);
  });

  it.each([
    ['no token', undefined],
    ['an empty token', ''],
    ['a token longer than any Cloudflare issues', 'x'.repeat(TURNSTILE_TOKEN_MAX + 1)],
  ])('refuses %s without asking Cloudflare', async (_name, token) => {
    const { asked, verify } = answering(good);

    expect(await verify(check({ token }))).toBe(false);
    expect(asked).toEqual([]);
  });

  it('refuses an origin it cannot read, without asking', async () => {
    const { asked, verify } = answering(good);

    expect(await verify(check({ origin: 'not an origin' }))).toBe(false);
    expect(asked).toEqual([]);
  });

  it('sends no address when it has none', async () => {
    const { asked, verify } = answering(good);

    await verify(check({ remoteIp: undefined }));

    expect(asked[0]?.form.has('remoteip')).toBe(false);
  });
});

/* ---- the mint ----------------------------------------------------------- */

let keys: Awaited<ReturnType<typeof loadWidgetTokenKeys>>;

beforeAll(async () => {
  keys = await loadWidgetTokenKeys(JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] }));
});

const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

const resolution = (turnstile: boolean): WidgetResolution => ({
  found: true,
  tenantId: '11111111-1111-4111-8111-111111111111',
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
  turnstile,
});

const mintApp = (turnstileOn: boolean, deps: Partial<WidgetDependencies> = {}) =>
  createApp({
    auth: fakeAuth(),
    readMemberships: oneMembership(),
    widget: {
      resolve: () => Promise.resolve(resolution(turnstileOn)),
      limiter: memoryRateLimiter(),
      readUsage: () => Promise.resolve(0),
      ipSecret: randomUUID(),
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: () => Promise.resolve(false),
      ...deps,
    },
  });

const mint = (built: ReturnType<typeof mintApp>, body?: unknown) =>
  built.request(`/v1/widget/session?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: {
      origin: ORIGIN,
      'x-forwarded-for': '203.0.113.7',
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const recording = (result: boolean) => {
  const seen: TurnstileCheck[] = [];

  return {
    seen,
    turnstile: {
      siteKey: 'site-key',
      verify: (checked: TurnstileCheck) => {
        seen.push(checked);
        return Promise.resolve(result);
      },
    },
  };
};

describe('the session mint', () => {
  it('asks nothing of a winery that has the challenge off, as before', async () => {
    const { seen, turnstile } = recording(false);

    const response = await mint(mintApp(false, { turnstile }));

    expect(response.status).toBe(200);
    expect(seen).toEqual([]);
  });

  it('mints for a winery that has it on, once the token verifies for this origin', async () => {
    const { seen, turnstile } = recording(true);

    const response = await mint(mintApp(true, { turnstile }), { turnstileToken: TOKEN });

    expect(response.status).toBe(200);
    expect(seen).toEqual([{ token: TOKEN, origin: ORIGIN, remoteIp: '203.0.113.7' }]);
  });

  it('refuses a token that does not verify', async () => {
    const { turnstile } = recording(false);

    const response = await mint(mintApp(true, { turnstile }), { turnstileToken: TOKEN });

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { message: TURNSTILE_REFUSED } });
  });

  it('refuses a mint that brought no token, without asking the verifier', async () => {
    /* Even one that would say yes: a missing token is the route's own refusal. */
    const { seen, turnstile } = recording(true);

    const response = await mint(mintApp(true, { turnstile }));

    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses a token that is not a string, without asking the verifier', async () => {
    const { seen, turnstile } = recording(true);

    const response = await mint(mintApp(true, { turnstile }), { turnstileToken: 42 });

    expect(response.status).toBe(403);
    expect(seen).toEqual([]);
  });

  it('refuses every mint when this deployment cannot verify a token', async () => {
    /* A challenge nobody can check is not passed. */
    const response = await mint(mintApp(true), { turnstileToken: TOKEN });

    expect(response.status).toBe(403);
  });
});
