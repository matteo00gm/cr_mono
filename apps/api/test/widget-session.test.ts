import { randomUUID } from 'node:crypto';

import { widgetSessionResponse } from '@catalogorosso/api-client';
import type { WidgetResolution } from '@catalogorosso/db';
import { memoryRateLimiter, WIDGET_LIMITS } from '@catalogorosso/security';
import {
  generateWidgetTokenKey,
  loadWidgetTokenKeys,
  type WidgetTokenKeys,
} from '@catalogorosso/security/tokens';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { WIDGET_SESSION_CACHE_CONTROL, type WidgetDependencies } from '../src/surfaces/widget.js';
import {
  mintWidgetSession,
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
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
  { origin = ORIGIN, body }: { origin?: string; body?: unknown } = {},
) =>
  built.request(`/v1/widget/session?key=${encodeURIComponent(KEY)}`, {
    method: 'POST',
    headers: { origin, 'x-forwarded-for': '203.0.113.7', 'content-type': 'application/json' },
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
    // Whole seconds, like the token: the 750 ms is dropped, not rounded up.
    expect(session.expiresAt).toBe('2026-09-15T10:15:00.000Z');
  });
});
