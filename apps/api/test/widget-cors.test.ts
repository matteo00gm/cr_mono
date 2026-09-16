import { randomUUID } from 'node:crypto';
import type { WidgetResolution } from '@catalogorosso/db';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv } from '../src/env.js';
import {
  PREFLIGHT_MAX_AGE_SEC,
  WIDGET_REFUSED,
  widgetCors,
  type RejectedWidgetRequest,
  type WidgetCorsOptions,
} from '../src/middleware/cors.js';
import { errorHandler } from '../src/middleware/error.js';
import { bucketIp } from '../src/middleware/ip-bucket.js';
import { requestContext } from '../src/middleware/logger.js';

/**
 * Dynamic CORS for the widget (P2-08).
 *
 * The middleware's decisions against a resolver the test controls: the five
 * rules, every refusal path, and the promise that a refusal's report can never
 * change the response. P2-09 extends this file with the exhaustive suite.
 */

const TENANT_A = '11111111-1111-4111-8111-111111111111';
const ORIGIN_A = 'https://cantina-rossi.example';

/** Assembled at runtime, never written as a literal (P0-56). */
const publicKey = (): string => ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');
const KEY_A = publicKey();

const FOUND_A: WidgetResolution = {
  found: true,
  tenantId: TENANT_A,
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
};

/**
 * A resolver over a table the test can change between requests, recording
 * every call — which is how "uncached" is asserted without a database.
 */
const resolver = (
  initial: Record<string, WidgetResolution> = { [`${KEY_A} ${ORIGIN_A}`]: FOUND_A },
) => {
  const table = new Map(Object.entries(initial));
  const calls: [string, string][] = [];

  const resolve: WidgetCorsOptions['resolve'] = (key, origin) => {
    calls.push([key, origin]);
    return Promise.resolve(
      table.get(`${key} ${origin}`) ??
        (key === KEY_A
          ? { found: false, reason: 'origin_mismatch', tenantId: TENANT_A }
          : { found: false, reason: 'unknown_key' }),
    );
  };

  return { resolve, calls, table };
};

const widgetApp = (options: WidgetCorsOptions, before?: (app: Hono<AppEnv>) => void) => {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext());
  app.onError(errorHandler);
  before?.(app);

  app.on(['GET', 'OPTIONS'], '/config', widgetCors(options), (c) =>
    c.json({ tenant: c.get('widgetTenant') }),
  );

  return app;
};

const request = (
  app: ReturnType<typeof widgetApp>,
  { method = 'GET', origin, key }: { method?: string; origin?: string; key?: string } = {},
) =>
  app.request(`/config${key === undefined ? '' : `?key=${encodeURIComponent(key)}`}`, {
    method,
    headers: origin === undefined ? {} : { origin },
  });

const CORS_HEADERS = [
  'access-control-allow-origin',
  'access-control-allow-credentials',
  'access-control-allow-methods',
  'access-control-allow-headers',
  'access-control-max-age',
  'access-control-expose-headers',
];

const corsHeadersOf = (response: Response) =>
  CORS_HEADERS.filter((name) => response.headers.has(name));

describe('an allowed request', () => {
  it('echoes the verified origin exactly, never *, with credentials off', async () => {
    const app = widgetApp({ resolve: resolver().resolve });

    const response = await request(app, { origin: ORIGIN_A, key: KEY_A });

    expect(response.status).toBe(200);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN_A);
    expect(response.headers.get('access-control-allow-credentials')).toBe('false');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('exposes the rate-limit headers the widget counts down from, and nothing else', async () => {
    const app = widgetApp({ resolve: resolver().resolve });

    const response = await request(app, { origin: ORIGIN_A, key: KEY_A });

    expect(response.headers.get('access-control-expose-headers')).toBe(
      'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset',
    );
  });

  it('hands the handler the tenant the pair resolved to', async () => {
    const app = widgetApp({ resolve: resolver().resolve });

    const response = await request(app, { origin: ORIGIN_A, key: KEY_A });

    expect(await response.json()).toEqual({
      tenant: { tenantId: TENANT_A, plan: 'CANTINA', status: 'ACTIVE', locale: 'it' },
    });
  });

  it('hands the handler the normalised origin it verified, which a session binds (P2-12)', async () => {
    const app = new Hono<AppEnv>();
    app.use('*', requestContext());
    app.onError(errorHandler);
    app.get('/config', widgetCors({ resolve: resolver().resolve }), (c) =>
      c.json({ origin: c.get('widgetOrigin') }),
    );

    const response = await request(app, { origin: ORIGIN_A.toUpperCase(), key: KEY_A });

    expect(await response.json()).toEqual({ origin: ORIGIN_A });
  });

  it('resolves against the normalised origin, and echoes that', async () => {
    const { resolve, calls } = resolver();
    const app = widgetApp({ resolve });

    const response = await request(app, { origin: 'HTTPS://CANTINA-ROSSI.EXAMPLE', key: KEY_A });

    expect(calls).toEqual([[KEY_A, ORIGIN_A]]);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN_A);
  });

  it('adds to a Vary header set earlier rather than replacing it', async () => {
    const app = widgetApp({ resolve: resolver().resolve }, (inner) => {
      inner.use('*', async (c, next) => {
        c.header('Vary', 'Accept-Encoding');
        await next();
      });
    });

    const vary = (await request(app, { origin: ORIGIN_A, key: KEY_A })).headers.get('vary') ?? '';

    expect(vary).toContain('Accept-Encoding');
    expect(vary).toContain('Origin');
  });
});

describe('a preflight', () => {
  it('runs the same resolution and answers with methods, headers and a short max-age', async () => {
    const { resolve, calls } = resolver();
    const app = widgetApp({ resolve });

    const response = await request(app, { method: 'OPTIONS', origin: ORIGIN_A, key: KEY_A });

    expect(response.status).toBe(204);
    expect(calls).toHaveLength(1);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN_A);
    expect(response.headers.get('access-control-allow-methods')).toBe('GET, POST, OPTIONS');
    expect(response.headers.get('access-control-allow-headers')).toBe(
      'Authorization, Content-Type',
    );
    expect(response.headers.get('access-control-max-age')).toBe(String(PREFLIGHT_MAX_AGE_SEC));
    expect(PREFLIGHT_MAX_AGE_SEC).toBe(600);
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('is refused exactly as the request it precedes would be', async () => {
    const app = widgetApp({ resolve: resolver().resolve });

    const response = await request(app, {
      method: 'OPTIONS',
      origin: 'https://evil.example',
      key: KEY_A,
    });

    expect(response.status).toBe(403);
    expect(corsHeadersOf(response)).toEqual([]);
  });
});

describe('a refusal', () => {
  const refusedBy = async (
    app: ReturnType<typeof widgetApp>,
    input: { method?: string; origin?: string; key?: string },
  ) => {
    const response = await request(app, input);

    return {
      status: response.status,
      cors: corsHeadersOf(response),
      vary: response.headers.get('vary'),
      message: ((await response.json()) as { error: { message: string } }).error.message,
    };
  };

  it.each<[string, { origin?: string; key?: string }, RejectedWidgetRequest['type']]>([
    ['no Origin at all', { key: KEY_A }, 'UNAUTHORIZED_ORIGIN'],
    ['an Origin of null', { origin: 'null', key: KEY_A }, 'UNAUTHORIZED_ORIGIN'],
    [
      'an origin that is not https',
      { origin: 'http://cantina-rossi.example', key: KEY_A },
      'UNAUTHORIZED_ORIGIN',
    ],
    ['no key', { origin: ORIGIN_A }, 'INVALID_KEY'],
    ['an empty key', { origin: ORIGIN_A, key: '' }, 'INVALID_KEY'],
    ['a key nobody issued', { origin: ORIGIN_A, key: 'pk_nobody' }, 'INVALID_KEY'],
    [
      'a real key from another site',
      { origin: 'https://evil.example', key: KEY_A },
      'UNAUTHORIZED_ORIGIN',
    ],
  ])('refuses %s with a bare 403 and reports %s', async (_label, input, type) => {
    const reported: RejectedWidgetRequest[] = [];
    const app = widgetApp({
      resolve: resolver().resolve,
      onRejected: (event) => {
        reported.push(event);
        return Promise.resolve();
      },
    });

    const refused = await refusedBy(app, input);

    // Rule 3: no CORS header of any kind. Rule 1: Vary even so.
    expect(refused).toEqual({ status: 403, cors: [], vary: 'Origin', message: WIDGET_REFUSED });
    expect(reported).toHaveLength(1);
    expect(reported[0]?.type).toBe(type);
  });

  it('answers a stolen key exactly as it answers an unknown one', async () => {
    /*
     * The distinction exists for P2-16's log. To a caller the two must be the
     * same bytes, or the widget becomes an oracle for which keys exist and which
     * sites own them.
     */
    const app = widgetApp({ resolve: resolver().resolve });

    const stolen = await refusedBy(app, { origin: 'https://evil.example', key: KEY_A });
    const unknown = await refusedBy(app, { origin: 'https://evil.example', key: 'pk_nobody' });

    expect(stolen).toEqual(unknown);
  });

  it("reports a stolen key with the key's tenant, and the origin and key as sent", async () => {
    const reported: RejectedWidgetRequest[] = [];
    const app = widgetApp({
      resolve: resolver().resolve,
      onRejected: (event) => {
        reported.push(event);
        return Promise.resolve();
      },
    });

    await request(app, { origin: 'https://EVIL.example', key: KEY_A });

    expect(reported).toEqual([
      {
        type: 'UNAUTHORIZED_ORIGIN',
        tenantId: TENANT_A,
        origin: 'https://EVIL.example',
        publicKey: KEY_A,
      },
    ]);
  });

  it('never asks the resolver without a usable origin and a key to ask about', async () => {
    const { resolve, calls } = resolver();
    const app = widgetApp({ resolve });

    await request(app, { origin: 'null', key: KEY_A });
    await request(app, { key: KEY_A });
    await request(app, { origin: ORIGIN_A });
    await request(app, { origin: ORIGIN_A, key: '' });

    expect(calls).toEqual([]);
  });
});

describe('the report', () => {
  it('cannot fail the request by rejecting', async () => {
    const app = widgetApp({
      resolve: resolver().resolve,
      onRejected: () => Promise.reject(new Error('security_events is down')),
    });

    expect((await request(app, { origin: 'https://evil.example', key: KEY_A })).status).toBe(403);
  });

  it('cannot fail the request by throwing', async () => {
    const app = widgetApp({
      resolve: resolver().resolve,
      onRejected: () => {
        throw new Error('the writer threw before it returned a promise');
      },
    });

    expect((await request(app, { origin: 'https://evil.example', key: KEY_A })).status).toBe(403);
  });

  it('defaults to a log line rather than to nothing', async () => {
    const app = widgetApp({ resolve: resolver().resolve });

    expect((await request(app, { origin: 'https://evil.example', key: KEY_A })).status).toBe(403);
  });
});

describe('no cache between the allowlist and the answer', () => {
  it('refuses the very next request once a domain is removed (§5.7)', async () => {
    const { resolve, table } = resolver();
    const app = widgetApp({ resolve });

    expect((await request(app, { origin: ORIGIN_A, key: KEY_A })).status).toBe(200);

    table.delete(`${KEY_A} ${ORIGIN_A}`);

    expect((await request(app, { origin: ORIGIN_A, key: KEY_A })).status).toBe(403);
  });
});

describe('development', () => {
  it('admits a local http origin only when told it is development', async () => {
    const local = 'http://localhost:5173';
    const { resolve } = resolver({ [`${KEY_A} ${local}`]: FOUND_A });

    const production = widgetApp({ resolve });
    const development = widgetApp({ resolve, environment: 'development' });

    expect((await request(production, { origin: local, key: KEY_A })).status).toBe(403);
    expect((await request(development, { origin: local, key: KEY_A })).status).toBe(200);
  });
});

/*
 * ---- P2-09: the exhaustive request-level suite ----------------------------
 *
 * Every P2-06 bypass string as a live request against a verified origin, and
 * two wineries whose keys and origins are swapped. The same strings run through
 * the real accessor in `widget-cors.integration.test.ts`.
 */

/** Two wineries; a real key from the wrong site is a mismatch against its owner. */
const twoWineries = () => {
  const TENANT_B = '22222222-2222-4222-8222-222222222222';
  const ORIGIN_B = 'https://cantina-verdi.example';
  const KEY_B = publicKey();

  const pairs = new Map<string, WidgetResolution>([
    [`${KEY_A} ${ORIGIN_A}`, FOUND_A],
    [`${KEY_B} ${ORIGIN_B}`, { ...FOUND_A, tenantId: TENANT_B }],
  ]);
  const owners = new Map([
    [KEY_A, TENANT_A],
    [KEY_B, TENANT_B],
  ]);

  const reported: RejectedWidgetRequest[] = [];

  const app = widgetApp({
    resolve: (key, origin) => {
      const found = pairs.get(`${key} ${origin}`);
      if (found !== undefined) return Promise.resolve(found);

      const owner = owners.get(key);
      const refusal: WidgetResolution =
        owner === undefined
          ? { found: false, reason: 'unknown_key' }
          : { found: false, reason: 'origin_mismatch', tenantId: owner };

      return Promise.resolve(refusal);
    },
    onRejected: (event) => {
      reported.push(event);
      return Promise.resolve();
    },
  });

  return { app, reported, TENANT_B, ORIGIN_B, KEY_B };
};

describe('every P2-06 bypass as a live request (P2-09)', () => {
  it.each([
    'https://evil-cantina-rossi.example',
    'https://cantina-rossi.example.attacker.io',
    'https://CANTINA-ROSSI.EXAMPLE.attacker.io',
    'https://cantína-rossi.example',
    'https://xn--cantina-rossi.example',
    'https://cantina-rossi.example%00.evil.io',
    'https://cantina-rossi.example%2eevil.io',
    'https://cantina-rossi.example@evil.io',
    'https://evil.io#@cantina-rossi.example',
    'https://evil.io?.cantina-rossi.example',
    'https://cantina-rossi.example:443.evil.io',
    'https://cantina-rossi.example/.evil.io',
    'https://*.cantina-rossi.example',
    'http://cantina-rossi.example',
    'https://cantina-rossi.example:8443',
    'https://ccantina-rossi.example',
    'https://cantina-rossi.examplee',
    'null',
    '',
  ])('refuses %j with a bare 403, and reports it', async (origin) => {
    const { app, reported } = twoWineries();

    const response = await request(app, { origin, key: KEY_A });

    expect(response.status).toBe(403);
    expect(corsHeadersOf(response)).toEqual([]);
    expect(response.headers.get('vary')).toContain('Origin');
    expect(reported).toHaveLength(1);
    expect(reported[0]?.type).toBe('UNAUTHORIZED_ORIGIN');
  });
});

describe('two wineries (P2-09)', () => {
  it("refuses one winery's origin with the other's key, and reports it against the key's owner", async () => {
    const { app, reported, KEY_B, TENANT_B } = twoWineries();

    const response = await request(app, { origin: ORIGIN_A, key: KEY_B });

    expect(response.status).toBe(403);
    expect(corsHeadersOf(response)).toEqual([]);
    expect(reported).toEqual([
      { type: 'UNAUTHORIZED_ORIGIN', tenantId: TENANT_B, origin: ORIGIN_A, publicKey: KEY_B },
    ]);
  });

  it('refuses the swap in the other direction too', async () => {
    const { app, reported, ORIGIN_B } = twoWineries();

    const response = await request(app, { origin: ORIGIN_B, key: KEY_A });

    expect(response.status).toBe(403);
    expect(reported).toEqual([
      { type: 'UNAUTHORIZED_ORIGIN', tenantId: TENANT_A, origin: ORIGIN_B, publicKey: KEY_A },
    ]);
  });

  it('allows each winery its own pair, and hands on the right tenant', async () => {
    const { app, KEY_B, ORIGIN_B, TENANT_B } = twoWineries();

    const rossi = await request(app, { origin: ORIGIN_A, key: KEY_A });
    const verdi = await request(app, { origin: ORIGIN_B, key: KEY_B });

    expect(((await rossi.json()) as { tenant: { tenantId: string } }).tenant.tenantId).toBe(
      TENANT_A,
    );
    expect(((await verdi.json()) as { tenant: { tenantId: string } }).tenant.tenantId).toBe(
      TENANT_B,
    );
    expect(verdi.headers.get('access-control-allow-origin')).toBe(ORIGIN_B);
  });

  it('refuses a swapped preflight exactly as it refuses the request', async () => {
    const { app, KEY_B } = twoWineries();

    const response = await request(app, { method: 'OPTIONS', origin: ORIGIN_A, key: KEY_B });

    expect(response.status).toBe(403);
    expect(corsHeadersOf(response)).toEqual([]);
  });
});

describe('a trailing-dot Origin (P2-09)', () => {
  it('gets an echo that is not its own, so a browser refuses the response', async () => {
    /*
     * The one spelling that normalises onto the verified origin without being
     * it. The browser compares the echo with its own serialised origin and
     * withholds the response — fail closed, by the browser's own rule.
     */
    const { app } = twoWineries();
    const dotted = `${ORIGIN_A}.`;

    const response = await request(app, { origin: dotted, key: KEY_A });

    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN_A);
    expect(response.headers.get('access-control-allow-origin')).not.toBe(dotted);
  });
});

describe('what a refusal hands the recorder (P2-16)', () => {
  const recording = (options: Partial<WidgetCorsOptions> = {}) => {
    const rejected: RejectedWidgetRequest[] = [];
    const app = widgetApp({
      resolve: resolver().resolve,
      onRejected: (event) => {
        rejected.push(event);
        return Promise.resolve();
      },
      ...options,
    });

    return { app, rejected };
  };

  it('carries the visitor as a bucket, never as an address', async () => {
    const ipSecret = randomUUID();
    const { app, rejected } = recording({ ipSecret });

    await request(app, { origin: 'https://evil.example', key: KEY_A });

    // The address never reaches the row; what does is P2-04's daily-salted HMAC.
    expect(rejected[0]?.ipBucket).toBe(bucketIp(undefined, ipSecret, Date.now()));
    expect(rejected[0]?.ipBucket).toMatch(/^[0-9a-f]{32}$/);
  });

  it('records no bucket at all when there is no secret to bucket with', async () => {
    const { app, rejected } = recording();

    await request(app, { origin: 'https://evil.example', key: KEY_A });

    expect(rejected[0]?.ipBucket).toBeUndefined();
    // A real key from a site its winery has not verified: the theft signal (§3.2).
    expect(rejected[0]?.type).toBe('UNAUTHORIZED_ORIGIN');
  });
});
