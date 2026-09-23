import { randomUUID } from 'node:crypto';

import { widgetSessionResponse } from '@catalogorosso/api-client';
import type { WidgetResolution } from '@catalogorosso/db';
import { memoryRateLimiter, WIDGET_LIMITS, type RateLimiter } from '@catalogorosso/security';
import {
  generateWidgetTokenKey,
  loadWidgetTokenKeys,
  type WidgetTokenKeys,
} from '@catalogorosso/security/tokens';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { WIDGET_SESSION_CACHE_CONTROL, type WidgetDependencies } from '../src/surfaces/widget.js';
import {
  bearerTokenOf,
  mintWidgetSession,
  WIDGET_SESSION_CONTINUATION_SEC,
  WIDGET_SESSION_MAX_LIFETIME_SEC,
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_REFUSED,
  WIDGET_TOKEN_TTL_SEC,
  WIDGET_UNAVAILABLE,
} from '../src/widget-session.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * `POST /v1/widget/session` (P2-12).
 *
 * What the mint puts in a token and where each part comes from — the tenant and
 * its status from resolution, the origin from CORS, the ids fresh — and what it
 * refuses. The attack table against the verifier is P2-15's; this is the half
 * that decides what there is to verify.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://cantina-rossi.example';

/** Assembled at runtime, never written as a literal (P0-56). */
const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type Found = Extract<WidgetResolution, { found: true }>;

const found = (over: Partial<Found> = {}): Found => ({
  found: true,
  tenantId: TENANT,
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
  ...over,
});

const UNKNOWN: WidgetResolution = { found: false, reason: 'unknown_key' };

const freshKeys = async (): Promise<WidgetTokenKeys> =>
  loadWidgetTokenKeys(JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] }));

/** A key loader that counts how often it is asked, to prove when keys are and are not touched. */
const counting = (keys: WidgetTokenKeys) => {
  const loads = { count: 0 };
  const load = () => {
    loads.count += 1;
    return Promise.resolve(keys);
  };
  return { loads, load };
};

const app = (overrides: Partial<WidgetDependencies> = {}) =>
  createApp({
    auth: fakeAuth(),
    readMemberships: oneMembership(),
    widget: {
      resolve: (key, origin) =>
        Promise.resolve(key === KEY && origin === ORIGIN ? found() : UNKNOWN),
      limiter: memoryRateLimiter(),
      readUsage: () => Promise.resolve(0),
      ipSecret: randomUUID(),
      ...overrides,
    },
  });

const mint = (
  built: ReturnType<typeof app>,
  {
    origin = ORIGIN,
    key = KEY,
    body,
    authorization,
  }: { origin?: string; key?: string; body?: unknown; authorization?: string } = {},
) =>
  built.request(`/v1/widget/session?key=${encodeURIComponent(key)}`, {
    method: 'POST',
    headers: {
      origin,
      'x-forwarded-for': '203.0.113.7',
      'content-type': 'application/json',
      ...(authorization === undefined ? {} : { authorization }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

const verified = async (keys: WidgetTokenKeys, response: Response) => {
  const body = widgetSessionResponse.parse(await response.json());
  const { payload } = await keys.verify(body.token, {
    issuer: WIDGET_TOKEN_ISSUER,
    audience: WIDGET_TOKEN_AUDIENCE,
  });
  return { body, payload };
};

describe('a minted session', () => {
  it('binds the tenant, the origin and a fresh session, and answers nothing but the token', async () => {
    const keys = await freshKeys();
    const response = await mint(app({ tokenKeys: () => Promise.resolve(keys) }));

    expect(response.status).toBe(200);

    // `widgetSessionResponse` is strict: a claim copied into the body fails here.
    const { body, payload } = await verified(keys, response);

    /*
     * The issuer and audience as literals, not the constants: a constant that
     * changes takes the test with it, and a moved issuer invalidates every live
     * token the moment it deploys.
     */
    expect(payload).toMatchObject({
      tid: TENANT,
      origin: ORIGIN,
      plan: 'CANTINA',
      iss: 'catalogorosso',
      aud: 'widget',
    });
    expect(payload.sid).toMatch(UUID_V4);
    expect(payload.jti).toMatch(UUID_V4);
    expect(payload.sid).not.toBe(payload.jti);
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(WIDGET_TOKEN_TTL_SEC);
    expect(new Date(body.expiresAt).getTime()).toBe((payload.exp ?? 0) * 1000);
  });

  it('gives every mint its own session and its own token id', async () => {
    const keys = await freshKeys();
    const built = app({ tokenKeys: () => Promise.resolve(keys) });

    const first = await verified(keys, await mint(built));
    const second = await verified(keys, await mint(built));

    expect(second.payload.sid).not.toBe(first.payload.sid);
    expect(second.payload.jti).not.toBe(first.payload.jti);
  });

  it('mints for a trialling tenant, and carries a tenant with no plan as a null plan', async () => {
    const keys = await freshKeys();
    const built = app({
      tokenKeys: () => Promise.resolve(keys),
      resolve: () => Promise.resolve(found({ status: 'TRIALING', plan: null })),
    });

    const { payload } = await verified(keys, await mint(built));

    expect(payload.plan).toBeNull();
  });

  it('is never cached', async () => {
    const keys = await freshKeys();
    const response = await mint(app({ tokenKeys: () => Promise.resolve(keys) }));

    expect(WIDGET_SESSION_CACHE_CONTROL).toBe('no-store');
    expect(response.headers.get('cache-control')).toBe('no-store');
  });
});

describe('what the caller cannot choose', () => {
  it('reads nothing from the body: a tenant, a session or an origin sent there is ignored', async () => {
    const keys = await freshKeys();
    const response = await mint(app({ tokenKeys: () => Promise.resolve(keys) }), {
      body: {
        tid: '22222222-2222-4222-8222-222222222222',
        sid: 'the-session-i-want',
        origin: 'https://evil.example',
        plan: 'ECOMMERCE',
      },
    });

    const { payload } = await verified(keys, response);

    expect(payload).toMatchObject({ tid: TENANT, origin: ORIGIN, plan: 'CANTINA' });
    expect(payload.sid).not.toBe('the-session-i-want');
  });

  it('binds the origin CORS verified, not the header as it was sent', async () => {
    const keys = await freshKeys();
    const response = await mint(app({ tokenKeys: () => Promise.resolve(keys) }), {
      origin: 'HTTPS://Cantina-Rossi.EXAMPLE',
    });

    const { payload } = await verified(keys, response);

    expect(payload.origin).toBe(ORIGIN);
  });
});

describe('what is refused', () => {
  it.each(['PENDING_VERIFICATION', 'PAST_DUE', 'DISABLED', 'CANCELED'] as const)(
    'a tenant that is %s: 403 unavailable, the same words, and no key touched',
    async (status) => {
      const { loads, load } = counting(await freshKeys());
      const response = await mint(
        app({ tokenKeys: load, resolve: () => Promise.resolve(found({ status })) }),
      );

      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({
        error: { code: 'unavailable', message: WIDGET_UNAVAILABLE },
      });
      // Unlike a refused pair, this one is readable: the widget has to see the code to render disabled.
      expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(loads.count).toBe(0);
    },
  );

  it('a switched-off tenant is told so even on a stage with no keyset', async () => {
    // The widget renders disabled for this; a wiring error would render as a broken widget.
    const response = await mint(
      app({ resolve: () => Promise.resolve(found({ status: 'DISABLED' })) }),
    );

    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ error: { code: 'unavailable' } });
  });

  it('a key and an origin that do not belong to one tenant, before any key is loaded', async () => {
    const { loads, load } = counting(await freshKeys());

    const response = await mint(app({ tokenKeys: load }), { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect(loads.count).toBe(0);
  });

  it("an address past the session budget, which is tighter than config's", async () => {
    // Minting is the cheapest thing on the surface to abuse (§3.6), so it counts against its own budget.
    const keys = await freshKeys();
    const built = app({ tokenKeys: () => Promise.resolve(keys) });
    const budget = WIDGET_LIMITS.ipPerMinute.session;

    for (let minted = 0; minted < budget; minted += 1) {
      expect((await mint(built)).status).toBe(200);
    }

    expect((await mint(built)).status).toBe(429);
    expect(budget).toBeLessThan(WIDGET_LIMITS.ipPerMinute.config);
  });
});

describe('wiring', () => {
  it('answers a wiring error, and mints nothing, on a stage with no keyset', async () => {
    const response = await mint(app());

    expect(response.status).toBe(500);
    expect(JSON.stringify(await response.json())).not.toContain('token');
  });

  it('fails loudly when the widget has no dependencies at all', async () => {
    const bare = createApp({ auth: fakeAuth(), readMemberships: oneMembership() });

    expect((await mint(bare)).status).toBe(500);
  });
});

describe('mintWidgetSession', () => {
  it('draws the session and the token id separately, and dates expiry from the clock given', async () => {
    const keys = await freshKeys();
    const ids = ['session-id', 'token-id'];
    const now = new Date('2026-09-15T10:00:00.750Z');

    const session = await mintWidgetSession({
      loadKeys: () => Promise.resolve(keys),
      tenant: { tenantId: TENANT, plan: 'ECOMMERCE', status: 'ACTIVE', locale: 'en' },
      origin: ORIGIN,
      now,
      newId: () => ids.shift() ?? 'no-more-ids',
    });

    const { payload } = await keys.verify(session.token, {
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      now,
    });

    expect(payload).toMatchObject({ sid: 'session-id', jti: 'token-id', plan: 'ECOMMERCE' });
    // A fresh session starts with this token.
    expect(payload.iat_original).toBe(payload.iat);
    // Whole seconds, like the token: the 750 ms is dropped, not rounded up.
    expect(session.expiresAt).toBe('2026-09-15T10:15:00.000Z');
  });

  const TENANT_ROW = { tenantId: TENANT, plan: 'CANTINA', status: 'ACTIVE', locale: 'it' } as const;
  const notRevoked = () => Promise.resolve(false);

  it('continues a session until its window closes, and not a second after (P2-12a)', async () => {
    const keys = await freshKeys();
    const loadKeys = () => Promise.resolve(keys);
    const minted = new Date('2026-09-15T10:00:00.000Z');
    const first = await mintWidgetSession({
      loadKeys,
      tenant: TENANT_ROW,
      origin: ORIGIN,
      now: minted,
    });
    const expSec = minted.getTime() / 1000 + WIDGET_TOKEN_TTL_SEC;

    const sidOf = async (token: string, now: Date) =>
      (
        await keys.verify(token, {
          issuer: WIDGET_TOKEN_ISSUER,
          audience: WIDGET_TOKEN_AUDIENCE,
          now,
        })
      ).payload.sid;

    const sidAfterLapse = async (lapsedSec: number) => {
      const now = new Date((expSec + lapsedSec) * 1000);
      const next = await mintWidgetSession({
        loadKeys,
        tenant: TENANT_ROW,
        origin: ORIGIN,
        previous: first.token,
        isRevoked: notRevoked,
        now,
      });
      return sidOf(next.token, now);
    };

    const firstSid = await sidOf(first.token, minted);

    expect(await sidAfterLapse(WIDGET_SESSION_CONTINUATION_SEC - 1)).toBe(firstSid);
    expect(await sidAfterLapse(WIDGET_SESSION_CONTINUATION_SEC)).not.toBe(firstSid);
  });

  it('continues a session up to its lifetime, and not a second past it (P2-12a)', async () => {
    const keys = await freshKeys();
    const loadKeys = () => Promise.resolve(keys);
    const sid = randomUUID();
    const startedAtSec = Date.parse('2026-09-15T06:00:00.000Z') / 1000;
    const endSec = startedAtSec + WIDGET_SESSION_MAX_LIFETIME_SEC;
    const options = { issuer: WIDGET_TOKEN_ISSUER, audience: WIDGET_TOKEN_AUDIENCE };

    const continuedAt = async (atSec: number) => {
      const now = new Date(atSec * 1000);
      // Minted a minute earlier, so the token is fresh and only the lifetime is in question.
      const previous = await keys.sign(
        {
          tid: TENANT,
          sid,
          origin: ORIGIN,
          plan: 'CANTINA',
          jti: randomUUID(),
          iat_original: startedAtSec,
        },
        { ...options, ttlSec: WIDGET_TOKEN_TTL_SEC, now: new Date((atSec - 60) * 1000) },
      );
      const next = await mintWidgetSession({
        loadKeys,
        tenant: TENANT_ROW,
        origin: ORIGIN,
        previous,
        isRevoked: notRevoked,
        now,
      });
      return (await keys.verify(next.token, { ...options, now })).payload;
    };

    expect(await continuedAt(endSec)).toMatchObject({ sid, iat_original: startedAtSec });

    const past = await continuedAt(endSec + 1);

    expect(past.sid).not.toBe(sid);
    expect(past.iat_original).toBe(endSec + 1);
  });
});

describe('continuing a session (P2-12a)', () => {
  const OTHER_ORIGIN = 'https://shop.cantina-rossi.example';
  const OTHER_TENANT = '33333333-3333-4333-8333-333333333333';
  /** Assembled at runtime, never written as a literal (P0-56). */
  const OTHER_KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

  const nowSec = (): number => Math.floor(Date.now() / 1000);
  const notRevoked = () => Promise.resolve(false);

  /** A token as a returning widget holds it, minted `issuedAgoSec` ago. */
  const heldToken = (
    keys: WidgetTokenKeys,
    claims: { sid: string; jti?: string; tid?: string; origin?: string; startedAtSec?: number },
    issuedAgoSec = 0,
  ) =>
    keys.sign(
      {
        tid: claims.tid ?? TENANT,
        sid: claims.sid,
        origin: claims.origin ?? ORIGIN,
        plan: 'CANTINA',
        jti: claims.jti ?? randomUUID(),
        iat_original: claims.startedAtSec ?? nowSec() - issuedAgoSec,
      },
      {
        issuer: WIDGET_TOKEN_ISSUER,
        audience: WIDGET_TOKEN_AUDIENCE,
        ttlSec: WIDGET_TOKEN_TTL_SEC,
        now: new Date(Date.now() - issuedAgoSec * 1000),
      },
    );

  /** How long ago a token was minted, for it to have expired `lapsedSec` ago. */
  const mintedAgoToHaveLapsed = (lapsedSec: number): number => WIDGET_TOKEN_TTL_SEC + lapsedSec;

  const refusalOf = async (response: Response) => {
    const { error } = (await response.json()) as { error: { code: string; message: string } };
    return { status: response.status, code: error.code, message: error.message };
  };

  /** Every refused continuation reads the same, whatever was wrong with it. */
  const REFUSED = { status: 401, code: 'unauthenticated', message: WIDGET_TOKEN_REFUSED };

  it("holds a session for the row's half hour past expiry, and four hours in all", () => {
    // As numbers, not through the constants: the boundary tests move with a constant that moves.
    expect(WIDGET_SESSION_CONTINUATION_SEC).toBe(1_800);
    expect(WIDGET_SESSION_MAX_LIFETIME_SEC).toBe(14_400);
  });

  it('starts afresh from a token we signed that names no session start', async () => {
    // Nothing to measure the lifetime from, so nothing to continue.
    const keys = await freshKeys();
    const sid = randomUUID();
    const previous = await keys.sign(
      { tid: TENANT, sid, origin: ORIGIN, plan: 'CANTINA', jti: randomUUID() },
      {
        issuer: WIDGET_TOKEN_ISSUER,
        audience: WIDGET_TOKEN_AUDIENCE,
        ttlSec: WIDGET_TOKEN_TTL_SEC,
      },
    );

    const response = await mint(
      app({ tokenKeys: () => Promise.resolve(keys), isTokenRevoked: notRevoked }),
      { authorization: `Bearer ${previous}` },
    );

    expect((await verified(keys, response)).payload.sid).not.toBe(sid);
  });

  it('keeps the session of a token that lapsed twenty minutes ago, under a new token id', async () => {
    const keys = await freshKeys();
    const sid = randomUUID();
    const jti = randomUUID();
    const startedAtSec = nowSec() - 60 * 60;
    const previous = await heldToken(
      keys,
      { sid, jti, startedAtSec },
      mintedAgoToHaveLapsed(20 * 60),
    );

    const response = await mint(
      app({ tokenKeys: () => Promise.resolve(keys), isTokenRevoked: notRevoked }),
      { authorization: `Bearer ${previous}` },
    );

    const { payload } = await verified(keys, response);

    expect(payload.sid).toBe(sid);
    expect(payload.jti).not.toBe(jti);
    expect(payload.iat_original).toBe(startedAtSec);
  });

  it('starts afresh from a token that lapsed beyond the window', async () => {
    const keys = await freshKeys();
    const sid = randomUUID();
    const previous = await heldToken(
      keys,
      { sid },
      mintedAgoToHaveLapsed(WIDGET_SESSION_CONTINUATION_SEC + 60),
    );

    const response = await mint(
      app({ tokenKeys: () => Promise.resolve(keys), isTokenRevoked: notRevoked }),
      { authorization: `Bearer ${previous}` },
    );

    const { payload } = await verified(keys, response);

    expect(payload.sid).not.toBe(sid);
    expect(payload.iat_original).toBe(payload.iat);
  });

  it('starts afresh once the session has run its lifetime, however fresh its token', async () => {
    const keys = await freshKeys();
    const built = app({ tokenKeys: () => Promise.resolve(keys), isTokenRevoked: notRevoked });
    const sid = randomUUID();

    const worn = await heldToken(keys, {
      sid,
      startedAtSec: nowSec() - WIDGET_SESSION_MAX_LIFETIME_SEC - 60,
    });
    const alive = await heldToken(keys, {
      sid,
      startedAtSec: nowSec() - WIDGET_SESSION_MAX_LIFETIME_SEC + 60,
    });

    const afterWorn = await verified(keys, await mint(built, { authorization: `Bearer ${worn}` }));
    const afterAlive = await verified(
      keys,
      await mint(built, { authorization: `Bearer ${alive}` }),
    );

    expect(afterWorn.payload.sid).not.toBe(sid);
    expect(afterAlive.payload.sid).toBe(sid);
  });

  it('never takes a session id on trust: a foreign token, a malformed one or another scheme starts afresh', async () => {
    const keys = await freshKeys();
    // The same kid and different material, as a forger holding only the kid would have.
    const forger = await freshKeys();
    const sid = randomUUID();
    const built = app({ tokenKeys: () => Promise.resolve(keys), isTokenRevoked: notRevoked });

    const attempts = [
      `Bearer ${await heldToken(forger, { sid })}`,
      'Bearer not-a-token',
      `Bearer ${sid}`,
      `Basic ${await heldToken(keys, { sid })}`,
    ];

    for (const authorization of attempts) {
      const response = await mint(built, { authorization });

      expect(response.status).toBe(200);
      expect((await verified(keys, response)).payload.sid).not.toBe(sid);
    }
  });

  it('refuses a token minted for another of the same winery’s sites', async () => {
    const keys = await freshKeys();
    const built = app({
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: notRevoked,
      resolve: (key, origin) =>
        Promise.resolve(
          key === KEY && (origin === ORIGIN || origin === OTHER_ORIGIN) ? found() : UNKNOWN,
        ),
    });
    const previous = await heldToken(keys, { sid: randomUUID(), origin: ORIGIN });

    const response = await mint(built, {
      origin: OTHER_ORIGIN,
      authorization: `Bearer ${previous}`,
    });

    expect(await refusalOf(response)).toEqual(REFUSED);
    // Readable, like every refusal after CORS: the widget drops the token and mints afresh.
    expect(response.headers.get('access-control-allow-origin')).toBe(OTHER_ORIGIN);
  });

  it("refuses a token from another winery's session, before asking whether it was revoked", async () => {
    const keys = await freshKeys();
    const asked: string[] = [];
    const built = app({
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: (tenantId, jti) => {
        asked.push(`${tenantId}:${jti}`);
        return Promise.resolve(false);
      },
      resolve: (key, origin) =>
        Promise.resolve(
          origin !== ORIGIN
            ? UNKNOWN
            : key === OTHER_KEY
              ? found({ tenantId: OTHER_TENANT })
              : key === KEY
                ? found()
                : UNKNOWN,
        ),
    });
    const previous = await heldToken(keys, { sid: randomUUID(), tid: TENANT });

    const response = await mint(built, { key: OTHER_KEY, authorization: `Bearer ${previous}` });

    expect(await refusalOf(response)).toEqual(REFUSED);
    expect(asked).toEqual([]);
  });

  it('refuses a revoked token, asking under the tenant this request resolved', async () => {
    const keys = await freshKeys();
    const jti = randomUUID();
    const asked: string[] = [];
    const built = app({
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: (tenantId, id) => {
        asked.push(`${tenantId}:${id}`);
        return Promise.resolve(id === jti);
      },
    });
    const previous = await heldToken(keys, { sid: randomUUID(), jti });

    const response = await mint(built, { authorization: `Bearer ${previous}` });

    expect(await refusalOf(response)).toEqual(REFUSED);
    expect(asked).toEqual([`${TENANT}:${jti}`]);
  });

  it('tells a switched-off winery it is unavailable before looking at any token', async () => {
    const keys = await freshKeys();
    const asked: string[] = [];
    const built = app({
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: (tenantId, jti) => {
        asked.push(`${tenantId}:${jti}`);
        return Promise.resolve(false);
      },
      resolve: () => Promise.resolve(found({ status: 'PAST_DUE' })),
    });
    const previous = await heldToken(keys, { sid: randomUUID() });

    const response = await mint(built, { authorization: `Bearer ${previous}` });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'unavailable',
      message: WIDGET_UNAVAILABLE,
    });
    expect(asked).toEqual([]);
  });

  it('ignores a previous token when nothing can say whether it was revoked', async () => {
    const keys = await freshKeys();
    const sid = randomUUID();
    const previous = await heldToken(keys, { sid });

    const response = await mint(app({ tokenKeys: () => Promise.resolve(keys) }), {
      authorization: `Bearer ${previous}`,
    });

    expect((await verified(keys, response)).payload.sid).not.toBe(sid);
  });

  it('spends the session budget, and never the month', async () => {
    const keys = await freshKeys();
    const inner = memoryRateLimiter();
    const counted: string[] = [];
    const limiter: RateLimiter = {
      check: (checks) => {
        counted.push(JSON.stringify(checks));
        return inner.check(checks);
      },
    };
    const built = app({
      tokenKeys: () => Promise.resolve(keys),
      isTokenRevoked: notRevoked,
      limiter,
    });
    const previous = await heldToken(keys, { sid: randomUUID() });

    expect((await mint(built, { authorization: `Bearer ${previous}` })).status).toBe(200);
    expect(counted.length).toBeGreaterThan(0);
    expect(counted.join('\n')).not.toContain('month');
  });
});

describe('bearerTokenOf', () => {
  it.each([
    ['Bearer abc.def.ghi', 'abc.def.ghi'],
    ['bearer   abc.def.ghi  ', 'abc.def.ghi'],
    ['Basic abc.def.ghi', undefined],
    ['Bearer', undefined],
    ['Bearer abc def', undefined],
    ['', undefined],
    [undefined, undefined],
  ])('%j reads as %j', (header, token) => {
    expect(bearerTokenOf(header)).toBe(token);
  });
});
