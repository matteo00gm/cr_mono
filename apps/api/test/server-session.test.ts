import { generateWidgetTokenKey, loadWidgetTokenKeys } from '@catalogorosso/security/tokens';
import { hashSecretKey, newPublicKey, newSecretKey } from '@catalogorosso/security/api-keys';
import type { LimitCheck, RateLimiter } from '@catalogorosso/security';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  mintServerSession,
  SECRET_KEY_IN_BROWSER,
  SECRET_KEY_REFUSED,
  SERVER_SESSIONS_PER_MINUTE,
  serverSessionLimitKey,
  type ServerSessionDeps,
} from '../src/server-session.js';

/**
 * A session minted by the seller's own server (P4-10, §3.2 layer 3).
 *
 * **The order of the checks is the design**, so most of this file asserts it:
 * each check must refuse before the next one costs anything. A request carrying
 * an `Origin` is refused before the key is read. A `pk_` sent as a secret is
 * refused before anything is hashed. An unknown key is refused before a rate
 * bucket is spent on it. An origin is checked only once the key is known.
 */

/** A token's claims, read without verifying — the mint's own tests verify it. */
const decodeJwt = (token: string): Record<string, unknown> =>
  JSON.parse(Buffer.from(token.split('.')[1] ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;

const TENANT = '11111111-1111-1111-1111-111111111111';
const ORIGIN = 'https://www.winery.com';

let keys: Awaited<ReturnType<typeof loadWidgetTokenKeys>>;

beforeAll(async () => {
  keys = await loadWidgetTokenKeys(JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] }));
});

/** Everything the deps were asked, in order, so the order can be asserted. */
const asked: string[] = [];
const limited: LimitCheck[][] = [];

/** Built at runtime, never written into this file (P0-56). */
const SECRET = newSecretKey();

const deps = (overrides: Partial<ServerSessionDeps> = {}, allowed = true): ServerSessionDeps => {
  const limiter: RateLimiter = {
    check: (checks) => {
      asked.push('limit');
      limited.push([...checks]);

      return Promise.resolve({
        allowed,
        remaining: allowed ? 1 : 0,
        resetAt: new Date(),
        limit: SERVER_SESSIONS_PER_MINUTE,
        key: checks[0]?.key ?? '',
      });
    },
  };

  return {
    resolve: (hash) => {
      asked.push('resolve');

      return Promise.resolve(
        hash === hashSecretKey(SECRET)
          ? {
              tenantId: TENANT,
              status: 'ACTIVE',
              plan: 'ECOMMERCE',
              locale: 'it',
              verifiedOrigins: [ORIGIN, 'https://winery.com'],
            }
          : undefined,
      );
    },
    limiter,
    loadKeys: () => {
      asked.push('keys');

      return Promise.resolve(keys);
    },
    isRevoked: () => Promise.resolve(false),
    ...overrides,
  };
};

const request = (overrides: Partial<Parameters<typeof mintServerSession>[0]> = {}) => ({
  originHeader: undefined,
  authorization: `Bearer ${SECRET}`,
  body: { origin: ORIGIN },
  ...overrides,
});

beforeEach(() => {
  asked.length = 0;
  limited.length = 0;
});

describe('a server presenting its secret key', () => {
  it('gets a session bound to the origin it named', async () => {
    const session = await mintServerSession(request(), deps());
    const claims = decodeJwt(session.token);

    expect(claims.origin).toBe(ORIGIN);
    expect(claims.tid).toBe(TENANT);
  });

  it('gets a token the browser path could not tell from its own', async () => {
    /*
     * The same mint, so every later check — origin binding, revocation, the
     * P4-06 cutoff — applies unchanged. A second kind of token would be a
     * second set of rules for somebody to forget.
     */
    const session = await mintServerSession(request(), deps());

    expect(Object.keys(session).sort()).toEqual(['expiresAt', 'token']);
    expect(decodeJwt(session.token)).toHaveProperty('iat_original');
  });

  it('may name the origin in any spelling the normaliser accepts', async () => {
    /* Exact equality after normalisation, not before: `WWW.Winery.COM.` is the
     * same origin to a browser, and the token is bound to the canonical form. */
    const session = await mintServerSession(
      request({ body: { origin: '  HTTPS://WWW.Winery.COM.  ' } }),
      deps(),
    );

    expect(decodeJwt(session.token).origin).toBe(ORIGIN);
  });
});

describe('a request carrying an Origin header', () => {
  it('is refused, because a browser sent it', async () => {
    /*
     * **A secret key in browser code is a leak**, and this makes it unusable
     * there even before the seller rotates it. A browser sends `Origin` on every
     * cross-origin POST; a server has no reason to.
     */
    await expect(
      mintServerSession(request({ originHeader: 'https://www.winery.com' }), deps()),
    ).rejects.toThrow(SECRET_KEY_IN_BROWSER);
  });

  it('is refused before the key is looked at, so the refusal says nothing about it', async () => {
    await expect(
      mintServerSession(request({ originHeader: 'https://evil.example' }), deps()),
    ).rejects.toThrow();

    expect(asked).toEqual([]);
  });

  it('is refused with the same answer for a real key and an invented one', async () => {
    const real = await mintServerSession(
      request({ originHeader: 'https://a.example' }),
      deps(),
    ).then(
      () => '',
      (error: unknown) => (error as Error).message,
    );
    const invented = await mintServerSession(
      request({ originHeader: 'https://a.example', authorization: 'Bearer nonsense' }),
      deps(),
    ).then(
      () => '',
      (error: unknown) => (error as Error).message,
    );

    expect(real).toBe(invented);
  });

  it('tells the seller to rotate, because the key has leaked', async () => {
    await expect(
      mintServerSession(request({ originHeader: 'https://www.winery.com' }), deps()),
    ).rejects.toThrow(/rotate/iu);
  });
});

describe('a key that is not a secret key at all', () => {
  it.each([
    ['a public key', () => `Bearer ${newPublicKey()}`],
    ['no header', () => undefined],
    ['another scheme', () => `Basic ${SECRET}`],
    ['a truncated secret', () => `Bearer ${SECRET.slice(0, 20)}`],
    ['a test key', () => `Bearer ${SECRET.replace('_live_', '_test_')}`],
  ])('is refused for %s, without a lookup', async (_name, header) => {
    /* The shape check is what keeps a `pk_` or a malformed header from costing
     * a hash and a query. */
    await expect(
      mintServerSession(request({ authorization: header() }), deps()),
    ).rejects.toMatchObject({ kind: 'unauthenticated' });

    expect(asked).toEqual([]);
  });
});

describe('a secret key we do not recognise', () => {
  it('is refused with the one answer every refused key gets', async () => {
    /* Unknown, revoked and rotated away all come back as nothing from the
     * resolver, and all answer the same — a caller that could tell them apart
     * could confirm a leaked key had once been real. */
    await expect(
      mintServerSession(request({ authorization: `Bearer ${newSecretKey()}` }), deps()),
    ).rejects.toThrow(SECRET_KEY_REFUSED);
  });

  it('spends no rate bucket, which would belong to nobody', async () => {
    await expect(
      mintServerSession(request({ authorization: `Bearer ${newSecretKey()}` }), deps()),
    ).rejects.toThrow();

    expect(asked).toEqual(['resolve']);
  });

  it('is looked up by hash, never by the key itself', async () => {
    const seen: string[] = [];

    await mintServerSession(
      request(),
      deps({
        resolve: (hash) => {
          seen.push(hash);

          return Promise.resolve(undefined);
        },
      }),
    ).catch(() => undefined);

    expect(seen).toEqual([hashSecretKey(SECRET)]);
    expect(seen[0]).not.toContain(SECRET);
  });
});

describe('the key own rate limit', () => {
  it('is counted per tenant, once the key is known', async () => {
    await mintServerSession(request(), deps());

    expect(limited).toEqual([
      [{ key: serverSessionLimitKey(TENANT), limit: SERVER_SESSIONS_PER_MINUTE, windowSec: 60 }],
    ]);
  });

  it('refuses once spent, before any token is signed', async () => {
    await expect(mintServerSession(request(), deps({}, false))).rejects.toMatchObject({
      kind: 'rate_limited',
    });

    expect(asked).not.toContain('keys');
  });
});

describe('the origin a server asks for', () => {
  it('must be one the winery has verified', async () => {
    await expect(
      mintServerSession(request({ body: { origin: 'https://evil.example' } }), deps()),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('is never matched by suffix', async () => {
    /* §3.4: suffix matching is defeated by `evil-winery.com`, and by a
     * subdomain nobody verified. */
    for (const origin of [
      'https://evil-winery.com',
      'https://shop.www.winery.com',
      'https://winery.com.evil.example',
    ]) {
      await expect(mintServerSession(request({ body: { origin } }), deps())).rejects.toMatchObject({
        kind: 'forbidden',
      });
    }
  });

  it('is refused when it is not an origin at all', async () => {
    await expect(
      mintServerSession(request({ body: { origin: 'not a url at all' } }), deps()),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('is normalised under the environment it runs in, as the browser path is', async () => {
    /*
     * P2-05's production rule refuses `http:` outright, and a local stack
     * verifies `http://localhost`. One rule for both paths: a server mint that
     * ignored the environment would refuse locally what the browser accepts, or
     * — the other way round — accept in production what the browser refuses.
     */
    const local = 'http://localhost:4001';
    const withLocal = deps({
      resolve: () =>
        Promise.resolve({
          tenantId: TENANT,
          status: 'ACTIVE',
          plan: 'ECOMMERCE',
          locale: 'it',
          verifiedOrigins: [local],
        }),
    });

    await expect(
      mintServerSession(request({ body: { origin: local } }), {
        ...withLocal,
        environment: 'development',
      }),
    ).resolves.toHaveProperty('token');
    await expect(
      mintServerSession(request({ body: { origin: local } }), {
        ...withLocal,
        environment: 'production',
      }),
    ).rejects.toMatchObject({ kind: 'forbidden' });
  });

  it('is told the problem plainly, because the caller holds the secret', async () => {
    /* Unlike a refusal on the browser path, this is the seller asking about
     * their own winery. Naming the problem leaks nothing they do not hold. */
    await expect(
      mintServerSession(request({ body: { origin: 'https://evil.example' } }), deps()),
    ).rejects.toThrow(/verified/iu);
  });

  it('is checked only after the key, so an invented key learns nothing about origins', async () => {
    await expect(
      mintServerSession(
        request({
          authorization: `Bearer ${newSecretKey()}`,
          body: { origin: 'https://evil.example' },
        }),
        deps(),
      ),
    ).rejects.toMatchObject({ kind: 'unauthenticated' });
  });
});

describe('the body', () => {
  it.each([
    ['nothing', null],
    ['no origin', {}],
    ['an empty origin', { origin: '' }],
    ['a tenant as well', { origin: ORIGIN, tenantId: TENANT }],
    ['a number', { origin: 42 }],
  ])('is refused when it carries %s', async (_name, body) => {
    await expect(mintServerSession(request({ body }), deps())).rejects.toMatchObject({
      kind: 'invalid',
    });
  });
});

describe('a winery the widget does not run for', () => {
  it.each(['PENDING_VERIFICATION', 'PAST_DUE', 'DISABLED', 'CANCELED'] as const)(
    'gets the disabled answer when %s, not a token',
    async (status) => {
      /* The same rule as the browser path (§1.3): holding a valid secret key does
       * not buy a session the winery's own status would not. */
      await expect(
        mintServerSession(
          request(),
          deps({
            resolve: () =>
              Promise.resolve({
                tenantId: TENANT,
                status,
                plan: 'ECOMMERCE',
                locale: 'it',
                verifiedOrigins: [ORIGIN],
              }),
          }),
        ),
      ).rejects.toMatchObject({ kind: 'unavailable' });
    },
  );
});
