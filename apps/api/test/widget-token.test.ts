import { createHmac, randomUUID } from 'node:crypto';

import type { WidgetResolution } from '@catalogorosso/db';
import {
  generateWidgetTokenKey,
  loadWidgetTokenKeys,
  type WidgetTokenKeys,
} from '@catalogorosso/security/tokens';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../src/env.js';
import { widgetCors, WIDGET_REFUSED } from '../src/middleware/cors.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/logger.js';
import { requireWidgetToken, type RejectedWidgetToken } from '../src/middleware/widget-auth.js';
import { WIDGET_UNAVAILABLE } from '../src/widget-config.js';
import {
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_REFUSED,
  WIDGET_TOKEN_TTL_SEC,
  type TokenRefusal,
} from '../src/widget-token.js';

/**
 * The attack table (P2-15, §3.4).
 *
 * **Named after the attacks rather than after the checks.** P2-13's suite walks
 * the verifier and asserts each check reaching its reason; this walks the other
 * direction, so a check deleted later fails a test called "replayed from another
 * verified site" rather than one called "origin binding". The two overlap on
 * purpose: the row asks for an attack table, and a table that shares its names
 * with the implementation is a table that stops meaning anything when the
 * implementation is renamed.
 *
 * Mounted as P2-29's chat will mount it: CORS, then the verifier. The limits
 * either side are P2-04's and P2-13's, and are asserted there.
 *
 * **The forgeries are built here, not signed by a library.** `apps/api` depends
 * on no JWT library, and what an attacker sends is a header and a payload they
 * chose with whatever signature they can produce — which is exactly what
 * `alg: none` and the HMAC confusion are.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://cantina-rossi.example';
/** A second site the same winery has verified. */
const OTHER_ORIGIN = 'https://shop.cantina-rossi.example';
/** A site nobody verified. */
const UNVERIFIED_ORIGIN = 'https://evil.example';

/** Assembled at runtime, never written as a literal (P0-56). */
const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

type Found = Extract<WidgetResolution, { found: true }>;

const found = (over: Partial<Found> = {}): Found => ({
  found: true,
  tenantId: TENANT,
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
  ...over,
});

const keysetOf = (jwk: unknown): string => JSON.stringify({ keys: [jwk] });

interface Harness {
  readonly keys: WidgetTokenKeys;
  /** The public half, for the key-as-HMAC-secret confusion. */
  readonly publicHalf: string;
  readonly app: Hono<AppEnv>;
  readonly rejected: RejectedWidgetToken[];
  /**
   * Every origin CORS actually asked the database about.
   *
   * Resolution is a query per request (P2-07), so an origin that is not a site
   * at all must be refused before it costs one — the same argument P2-04 makes
   * about invented keys.
   */
  readonly resolutions: string[];
  /** Changed mid-test, as removing a domain or lapsing a subscription changes it. */
  readonly state: { resolution: WidgetResolution; readonly revoked: Set<string> };
}

const guarded = async (): Promise<Harness> => {
  const jwk = await generateWidgetTokenKey('k1');
  const keys = await loadWidgetTokenKeys(keysetOf(jwk));
  const rejected: RejectedWidgetToken[] = [];
  const resolutions: string[] = [];
  const state = { resolution: found() as WidgetResolution, revoked: new Set<string>() };

  const app = new Hono<AppEnv>();
  app.use('*', requestContext());
  app.onError(errorHandler);
  app.post(
    '/chat',
    widgetCors({
      resolve: (publicKey, origin) => {
        resolutions.push(origin);

        return Promise.resolve(
          publicKey === KEY && (origin === ORIGIN || origin === OTHER_ORIGIN)
            ? state.resolution
            : { found: false, reason: 'unknown_key' },
        );
      },
    }),
    requireWidgetToken({
      loadKeys: () => Promise.resolve(keys),
      isRevoked: (tenantId, jti) => Promise.resolve(tenantId === TENANT && state.revoked.has(jti)),
      onRejected: (event) => {
        rejected.push(event);
        return Promise.resolve();
      },
    }),
    (c) => c.json({ sessionId: c.get('widgetSessionId') }),
  );

  return { keys, publicHalf: jwk.x ?? '', app, rejected, resolutions, state };
};

/** `app.request` answers either way round; every attack below awaits one thing. */
const send = (
  { app }: Harness,
  { token, origin = ORIGIN }: { token?: string | undefined; origin?: string | null } = {},
): Promise<Response> =>
  Promise.resolve(
    app.request(`/chat?key=${encodeURIComponent(KEY)}`, {
      method: 'POST',
      headers: {
        ...(origin === null ? {} : { origin }),
        'x-forwarded-for': '203.0.113.7',
        ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
      },
    }),
  );

/** A token as the mint issues one (P2-12), with any claim or the audience replaced. */
const minted = (
  keys: WidgetTokenKeys,
  claims: Record<string, unknown> = {},
  { audience = WIDGET_TOKEN_AUDIENCE, mintedAt = new Date() } = {},
): Promise<string> =>
  keys.sign(
    {
      tid: TENANT,
      sid: randomUUID(),
      origin: ORIGIN,
      plan: 'CANTINA',
      jti: randomUUID(),
      iat_original: Math.floor(mintedAt.getTime() / 1000),
      ...claims,
    },
    { issuer: WIDGET_TOKEN_ISSUER, audience, ttlSec: WIDGET_TOKEN_TTL_SEC, now: mintedAt },
  );

const segment = (value: object): string => Buffer.from(JSON.stringify(value)).toString('base64url');

/** Claims that would pass every check, as an attacker writes them. */
const claims = (): Record<string, unknown> => {
  const nowSec = Math.floor(Date.now() / 1000);

  return {
    tid: TENANT,
    sid: randomUUID(),
    origin: ORIGIN,
    plan: 'CANTINA',
    jti: randomUUID(),
    iat_original: nowSec,
    iss: WIDGET_TOKEN_ISSUER,
    aud: WIDGET_TOKEN_AUDIENCE,
    iat: nowSec,
    exp: nowSec + WIDGET_TOKEN_TTL_SEC,
  };
};

/** `alg: none`: the header says there is no signature, and there is none. */
const unsigned = (): string =>
  `${segment({ alg: 'none', kid: 'k1', typ: 'JWT' })}.${segment(claims())}.`;

/** HS256 signed with the verifying key as the secret — asymmetric-to-symmetric confusion. */
const hmacSigned = (publicHalf: string): string => {
  const signingInput = `${segment({ alg: 'HS256', kid: 'k1', typ: 'JWT' })}.${segment(claims())}`;
  const signature = createHmac('sha256', Buffer.from(publicHalf, 'base64url'))
    .update(signingInput)
    .digest('base64url');

  return `${signingInput}.${signature}`;
};

/** A real token with one claim edited and the signature left as it was. */
const edited = (token: string, over: Record<string, unknown>): string => {
  const [header = '', payload = '', signature = ''] = token.split('.');
  const original = JSON.parse(Buffer.from(payload, 'base64url').toString()) as Record<
    string,
    unknown
  >;

  return `${header}.${segment({ ...original, ...over })}.${signature}`;
};

const freshKeys = async (): Promise<WidgetTokenKeys> =>
  loadWidgetTokenKeys(keysetOf(await generateWidgetTokenKey('k1')));

const refusalOf = async (response: Response) => {
  const { error } = (await response.json()) as { error: { code: string; message: string } };

  return { status: response.status, code: error.code, message: error.message };
};

/** The body with only its request id removed. Everything else has to match, byte for byte. */
const withoutRequestId = (body: string): string => {
  const { error } = JSON.parse(body) as { error: Record<string, unknown> };
  const { requestId, ...rest } = error;
  void requestId;

  return JSON.stringify(rest);
};

const REFUSED = { status: 401, code: 'unauthenticated', message: WIDGET_TOKEN_REFUSED };

interface TokenAttack {
  readonly name: string;
  /** What the verifier records for P2-16, which never reaches the caller. */
  readonly reason: TokenRefusal;
  readonly forge: (harness: Harness) => Promise<Response>;
}

const TOKEN_ATTACKS: readonly TokenAttack[] = [
  {
    name: 'replayed from another verified site of the same winery',
    reason: 'origin_mismatch',
    forge: async (h) => send(h, { token: await minted(h.keys), origin: OTHER_ORIGIN }),
  },
  {
    name: 'minted for another winery on the same keyset',
    reason: 'tenant_mismatch',
    forge: async (h) => send(h, { token: await minted(h.keys, { tid: OTHER_TENANT }) }),
  },
  {
    name: 'revoked before it expired',
    reason: 'revoked',
    forge: async (h) => {
      const jti = randomUUID();
      h.state.revoked.add(jti);

      return send(h, { token: await minted(h.keys, { jti }) });
    },
  },
  {
    name: 'expired a minute ago',
    reason: 'invalid',
    forge: async (h) =>
      send(h, {
        token: await minted(
          h.keys,
          {},
          { mintedAt: new Date(Date.now() - (WIDGET_TOKEN_TTL_SEC + 60) * 1000) },
        ),
      }),
  },
  {
    name: 'expired inside the window only a continuation is given',
    reason: 'invalid',
    forge: async (h) =>
      send(h, {
        token: await minted(
          h.keys,
          {},
          { mintedAt: new Date(Date.now() - (WIDGET_TOKEN_TTL_SEC + 10 * 60) * 1000) },
        ),
      }),
  },
  {
    name: 'signed with alg none, naming a key this service holds',
    reason: 'invalid',
    forge: (h) => send(h, { token: unsigned() }),
  },
  {
    name: 'HMAC-signed with the verifying key as the secret',
    reason: 'invalid',
    forge: (h) => send(h, { token: hmacSigned(h.publicHalf) }),
  },
  {
    name: 'minted for the dashboard audience',
    reason: 'invalid',
    forge: async (h) => send(h, { token: await minted(h.keys, {}, { audience: 'dashboard' }) }),
  },
  {
    name: 'a real token with its tenant claim edited',
    reason: 'invalid',
    forge: async (h) => send(h, { token: edited(await minted(h.keys), { tid: OTHER_TENANT }) }),
  },
  {
    name: 'a real token with its origin claim edited',
    reason: 'invalid',
    forge: async (h) =>
      send(h, { token: edited(await minted(h.keys), { origin: UNVERIFIED_ORIGIN }) }),
  },
  {
    name: 'signed by a key this service does not hold',
    reason: 'invalid',
    forge: async (h) => send(h, { token: await minted(await freshKeys()) }),
  },
];

describe('a token that must not work', () => {
  it.each(TOKEN_ATTACKS)('$name', async ({ reason, forge }) => {
    const harness = await guarded();

    const response = await forge(harness);

    expect(await refusalOf(response)).toEqual(REFUSED);
    expect(harness.rejected.map((event) => event.reason)).toEqual([reason]);
  });

  it('is answered byte for byte the same way, whatever was wrong with it', async () => {
    /*
     * **The oracle this closes.** A caller who can tell "expired" from "revoked"
     * from "minted for someone else" learns which sessions exist and where they
     * were minted — from a surface that is public by design. The reason is in
     * `security_events` and nowhere else.
     */
    const bodies = new Set<string>();
    const statuses = new Set<number>();

    for (const attack of TOKEN_ATTACKS) {
      const response = await attack.forge(await guarded());

      statuses.add(response.status);
      bodies.add(withoutRequestId(await response.text()));
    }

    expect([...statuses]).toEqual([401]);
    expect([...bodies]).toHaveLength(1);
  });

  it('carries a request id, which is the only thing that differs between two of them', async () => {
    const harness = await guarded();

    const [first, second] = await Promise.all([
      send(harness, { token: unsigned() }),
      send(harness, { token: unsigned() }),
    ]);
    const bodies = await Promise.all([first.text(), second.text()]);

    for (const body of bodies) {
      expect((JSON.parse(body) as { error: { requestId: string } }).error.requestId).toMatch(/\S/);
    }
    expect(bodies[0]).not.toBe(bodies[1]);
    expect(withoutRequestId(bodies[0])).toBe(withoutRequestId(bodies[1]));
  });
});

describe('a request refused before its token is read', () => {
  it('arrives with no Origin at all', async () => {
    const harness = await guarded();

    const response = await send(harness, { token: await minted(harness.keys), origin: null });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'forbidden',
      message: WIDGET_REFUSED,
    });
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    // Refused by CORS, so the verifier never saw it and recorded nothing.
    expect(harness.rejected).toEqual([]);
    // And nothing was resolved for it: a request with no origin costs no query.
    expect(harness.resolutions).toEqual([]);
  });

  it('comes from a site the winery has not verified', async () => {
    const harness = await guarded();

    const response = await send(harness, {
      token: await minted(harness.keys),
      origin: UNVERIFIED_ORIGIN,
    });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'forbidden',
      message: WIDGET_REFUSED,
    });
    expect(harness.rejected).toEqual([]);
    // A real site, so it is the database that refuses it — the contrast with the two below.
    expect(harness.resolutions).toEqual([UNVERIFIED_ORIGIN]);
  });

  it('claims an origin of "null", as a sandboxed frame does', async () => {
    /*
     * The header a sandboxed iframe or a `file://` page sends. It normalises to
     * nothing, and is refused before the database is asked: admitting it would
     * let any page in the world carry the widget, and asking about it would hand
     * one free query to anybody who can open a frame (P2-04, P2-05).
     */
    const harness = await guarded();

    const response = await send(harness, { token: await minted(harness.keys), origin: 'null' });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'forbidden',
      message: WIDGET_REFUSED,
    });
    expect(harness.resolutions).toEqual([]);
    expect(harness.rejected).toEqual([]);
  });

  it('claims a bare address rather than a site', async () => {
    // P2-05 rejects raw addresses, localhost and private ranges: none is a site a winery can verify.
    const harness = await guarded();

    const response = await send(harness, {
      token: await minted(harness.keys),
      origin: 'http://198.51.100.10',
    });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'forbidden',
      message: WIDGET_REFUSED,
    });
    expect(harness.resolutions).toEqual([]);
    expect(harness.rejected).toEqual([]);
  });

  it('presents a token minted before its domain was removed', async () => {
    // Resolution runs on every request (P2-07), so removing a domain stops its
    // live tokens now rather than at expiry — before the token is even read.
    const harness = await guarded();
    const token = await minted(harness.keys);

    harness.state.resolution = { found: false, reason: 'origin_mismatch', tenantId: TENANT };
    const response = await send(harness, { token });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'forbidden',
      message: WIDGET_REFUSED,
    });
    expect(harness.rejected).toEqual([]);
  });

  it('belongs to a winery that has been switched off', async () => {
    /*
     * `unavailable`, not the 401 every token refusal gets: the widget renders a
     * disabled state for this (P3-21), and a tenant's status is already public
     * through config, so it answers no question a caller could not ask anyway.
     */
    const harness = await guarded();
    const token = await minted(harness.keys);

    harness.state.resolution = found({ status: 'DISABLED' });
    const response = await send(harness, { token });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'unavailable',
      message: WIDGET_UNAVAILABLE,
    });
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(harness.rejected).toEqual([]);
  });
});

describe('the one token that works', () => {
  it('is the one this service minted, for this winery and this site, unexpired and unrevoked', async () => {
    // The table above is only meaningful if the honest request still passes.
    const harness = await guarded();
    const sid = randomUUID();

    const response = await send(harness, { token: await minted(harness.keys, { sid }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: sid });
    expect(harness.rejected).toEqual([]);
  });
});
