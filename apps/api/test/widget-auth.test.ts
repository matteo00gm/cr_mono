import { randomUUID } from 'node:crypto';

import type { WidgetResolution } from '@catalogorosso/db';
import { memoryRateLimiter, type RateLimiter } from '@catalogorosso/security';
import {
  generateWidgetTokenKey,
  loadWidgetTokenKeys,
  type WidgetTokenKeys,
} from '@catalogorosso/security/tokens';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../src/env.js';
import { widgetCors } from '../src/middleware/cors.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/logger.js';
import { bucketIp } from '../src/middleware/ip-bucket.js';
import { limitWidgetRequest } from '../src/middleware/rate-limit.js';
import {
  requireWidgetToken,
  type RejectedWidgetToken,
  type WidgetAuthOptions,
} from '../src/middleware/widget-auth.js';
import { WIDGET_UNAVAILABLE } from '../src/widget-config.js';
import {
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_REFUSED,
  WIDGET_TOKEN_TTL_SEC,
  type TokenRefusal,
} from '../src/widget-token.js';

/**
 * The widget token verify middleware (P2-13).
 *
 * Mounted here as a route that needs a session will mount it (P2-29): CORS,
 * then this, then the tenant's limits. What is asserted is each of §3.4's
 * checks reaching its reason, the one answer every refusal gets, and where the
 * middleware sits relative to the guards either side of it. The full attack
 * table — `alg: none`, HMAC confusion, a dashboard audience, a tampered claim —
 * is P2-15's.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const OTHER_TENANT = '22222222-2222-4222-8222-222222222222';
const ORIGIN = 'https://cantina-rossi.example';
const OTHER_ORIGIN = 'https://shop.cantina-rossi.example';

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

const freshKeys = async (): Promise<WidgetTokenKeys> =>
  loadWidgetTokenKeys(JSON.stringify({ keys: [await generateWidgetTokenKey('k1')] }));

/** A token as the mint issues one (P2-12), with any claim replaced. */
const tokenFor = (
  keys: WidgetTokenKeys,
  claims: Record<string, unknown> = {},
  mintedAt = new Date(),
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
    {
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      ttlSec: WIDGET_TOKEN_TTL_SEC,
      now: mintedAt,
    },
  );

/** A route that needs a session, guarded as P2-29's chat will be, recording what each layer saw. */
const harness = async ({
  resolution = found(),
  options = {},
}: {
  resolution?: WidgetResolution;
  options?: Partial<WidgetAuthOptions>;
} = {}) => {
  const keys = await freshKeys();
  const rejected: RejectedWidgetToken[] = [];
  const loads = { count: 0 };
  const counted: string[] = [];
  const inner = memoryRateLimiter();
  const limiter: RateLimiter = {
    check: (checks) => {
      counted.push(...checks.map((check) => check.key));
      return inner.check(checks);
    },
  };

  const app = new Hono<AppEnv>();
  app.use('*', requestContext());
  app.onError(errorHandler);
  app.on(
    ['POST', 'OPTIONS'],
    '/chat',
    widgetCors({
      resolve: (publicKey, origin) =>
        Promise.resolve(
          publicKey === KEY && (origin === ORIGIN || origin === OTHER_ORIGIN)
            ? resolution
            : { found: false, reason: 'unknown_key' },
        ),
    }),
    requireWidgetToken({
      loadKeys: () => {
        loads.count += 1;
        return Promise.resolve(keys);
      },
      isRevoked: () => Promise.resolve(false),
      onRejected: (event) => {
        rejected.push(event);
        return Promise.resolve();
      },
      ...options,
    }),
    limitWidgetRequest({ limiter, endpoint: 'chat', ipSecret: randomUUID() }),
    (c) => c.json({ sessionId: c.get('widgetSessionId') }),
  );

  return { keys, rejected, loads, counted, app };
};

const send = (
  app: Hono<AppEnv>,
  {
    token,
    origin = ORIGIN,
    method = 'POST',
  }: { token?: string | undefined; origin?: string; method?: string } = {},
) =>
  app.request(`/chat?key=${encodeURIComponent(KEY)}`, {
    method,
    headers: {
      origin,
      'x-forwarded-for': '203.0.113.7',
      ...(token === undefined ? {} : { authorization: `Bearer ${token}` }),
    },
  });

const refusalOf = async (response: Response) => {
  const { error } = (await response.json()) as { error: { code: string; message: string } };
  return { status: response.status, code: error.code, message: error.message };
};

const REFUSED = { status: 401, code: 'unauthenticated', message: WIDGET_TOKEN_REFUSED };

describe('an accepted token', () => {
  it('hands the handler the session the token names', async () => {
    const { keys, app, rejected } = await harness();
    const sid = randomUUID();

    const response = await send(app, { token: await tokenFor(keys, { sid }) });

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sessionId: sid });
    expect(rejected).toEqual([]);
  });

  it("counts the request against that session's own limit", async () => {
    const { keys, app, counted } = await harness();
    const sid = randomUUID();

    await send(app, { token: await tokenFor(keys, { sid }) });

    expect(counted).toContain(`session:${sid}:chat`);
  });
});

describe('a refused token: one 401, and the reason only for the record', () => {
  const cases: readonly [
    TokenRefusal,
    string,
    (keys: WidgetTokenKeys) => Promise<string | undefined>,
  ][] = [
    ['absent', 'no token at all', () => Promise.resolve(undefined)],
    [
      'invalid',
      'signed by a key this service does not hold',
      async () => tokenFor(await freshKeys()),
    ],
    [
      'invalid',
      'expired a minute ago, well inside the window only a continuation gets',
      (keys) => tokenFor(keys, {}, new Date(Date.now() - (WIDGET_TOKEN_TTL_SEC + 60) * 1000)),
    ],
    [
      'origin_mismatch',
      "minted for another of the winery's sites",
      (keys) => tokenFor(keys, { origin: OTHER_ORIGIN }),
    ],
    [
      'tenant_mismatch',
      'minted for another winery',
      (keys) => tokenFor(keys, { tid: OTHER_TENANT }),
    ],
    ['malformed', 'ours, with a session id that is not one', (keys) => tokenFor(keys, { sid: 42 })],
  ];

  it.each(cases)('%s: %s', async (reason, _label, make) => {
    const { keys, app, rejected } = await harness();

    const response = await send(app, { token: await make(keys) });

    expect(await refusalOf(response)).toEqual(REFUSED);
    // Readable, like every refusal after CORS: the widget drops the token and mints again.
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(rejected).toEqual([{ reason, tenantId: TENANT, origin: ORIGIN }]);
  });

  it('revoked: asked under the tenant CORS resolved, about the token’s own id', async () => {
    const asked: string[] = [];
    const jti = randomUUID();
    const { keys, app, rejected } = await harness({
      options: {
        isRevoked: (tenantId, id) => {
          asked.push(`${tenantId}:${id}`);
          return Promise.resolve(true);
        },
      },
    });

    const response = await send(app, { token: await tokenFor(keys, { jti }) });

    expect(await refusalOf(response)).toEqual(REFUSED);
    expect(asked).toEqual([`${TENANT}:${jti}`]);
    expect(rejected).toEqual([{ reason: 'revoked', tenantId: TENANT, origin: ORIGIN }]);
  });

  it('checks expiry against the clock it is given', async () => {
    const minted = new Date('2026-09-15T10:00:00.000Z');
    const at = (secondsAfterMint: number) => () =>
      new Date(minted.getTime() + secondsAfterMint * 1000);
    const live = await harness({ options: { now: at(WIDGET_TOKEN_TTL_SEC - 1) } });
    const lapsed = await harness({ options: { now: at(WIDGET_TOKEN_TTL_SEC + 60) } });

    const liveResponse = await send(live.app, { token: await tokenFor(live.keys, {}, minted) });
    const lapsedResponse = await send(lapsed.app, {
      token: await tokenFor(lapsed.keys, {}, minted),
    });

    expect(liveResponse.status).toBe(200);
    expect(await refusalOf(lapsedResponse)).toEqual(REFUSED);
  });

  it('a reporter that fails, however it fails, changes nothing the caller sees', async () => {
    const rejecting = await harness({
      options: { onRejected: () => Promise.reject(new Error('security_events is down')) },
    });
    const throwing = await harness({
      options: {
        onRejected: () => {
          throw new Error('security_events is down');
        },
      },
    });

    expect(await refusalOf(await send(rejecting.app))).toEqual(REFUSED);
    expect(await refusalOf(await send(throwing.app))).toEqual(REFUSED);
  });
});

describe('before the token is read', () => {
  it('tells a switched-off winery it is unavailable, and loads no key', async () => {
    const { keys, app, loads, rejected } = await harness({
      resolution: found({ status: 'DISABLED' }),
    });

    const response = await send(app, { token: await tokenFor(keys) });

    expect(await refusalOf(response)).toEqual({
      status: 403,
      code: 'unavailable',
      message: WIDGET_UNAVAILABLE,
    });
    expect(loads.count).toBe(0);
    expect(rejected).toEqual([]);
  });

  it('leaves a preflight to CORS, which answers it without any token', async () => {
    const { app, loads } = await harness();

    const response = await send(app, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(loads.count).toBe(0);
  });

  it('fails loudly when mounted without CORS in front of it', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.onError(errorHandler);
    app.post(
      '/chat',
      requireWidgetToken({
        loadKeys: freshKeys,
        isRevoked: () => Promise.resolve(false),
      }),
      (c) => c.json({ sessionId: c.get('widgetSessionId') }),
    );

    expect((await send(app)).status).toBe(500);
  });
});

describe('what a refusal hands the recorder (P2-16)', () => {
  it('carries the visitor as a bucket, never as an address', async () => {
    const ipSecret = randomUUID();
    const { app, rejected } = await harness({ options: { ipSecret } });

    await send(app);

    expect(rejected[0]?.ipBucket).toBe(bucketIp('203.0.113.7', ipSecret, Date.now()));
    expect(rejected[0]?.ipBucket).not.toContain('203.0.113.7');
  });

  it('records no bucket at all when there is no secret to bucket with', async () => {
    // Restrictive: a refusal without a bucket, never a refusal with an address.
    const { app, rejected } = await harness();

    await send(app);

    expect(rejected[0]?.ipBucket).toBeUndefined();
  });
});
