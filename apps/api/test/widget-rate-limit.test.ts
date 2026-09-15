import { randomUUID } from 'node:crypto';
import {
  memoryRateLimiter,
  type LimitCheck,
  type RateLimiter,
  type WidgetLimits,
} from '@catalogorosso/security';
import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';

import type { AppEnv, WidgetTenant } from '../src/env.js';
import { errorHandler } from '../src/middleware/error.js';
import { requestContext } from '../src/middleware/logger.js';
import { limitUnresolvedWidgetRequest, limitWidgetRequest } from '../src/middleware/rate-limit.js';

/**
 * Widget rate limiting through HTTP (P2-04).
 *
 * The dimensions themselves are asserted in `packages/security`; what is
 * asserted here is what a caller sees. Each dimension trips on its own, a
 * refusal carries the headers a client needs, the plan cap's numbers never
 * leave the building, and an address never becomes a key.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const CANTINA: WidgetTenant = { tenantId: TENANT, plan: 'CANTINA', status: 'ACTIVE', locale: 'it' };
const SECRET = randomUUID();

/** Every dimension roomy, so each test can shrink exactly one. */
const ROOMY: WidgetLimits = {
  unresolvedPerMinute: 100,
  sessionPerMinute: { session: 100, chat: 100 },
  ipPerMinute: { config: 100, session: 100, chat: 100 },
  tenantPerMinute: { CANTINA: 100, ECOMMERCE: 100, none: 100 },
  endpointPerMinute: { config: 100, session: 100, chat: 100 },
  messagesPerMonth: { CANTINA: 100, ECOMMERCE: 100, none: 100 },
};

/** A limiter that remembers what it was asked. */
const recording = (inner: RateLimiter = memoryRateLimiter()) => {
  const seen: LimitCheck[][] = [];

  const limiter: RateLimiter = {
    check: (checks) => {
      seen.push([...checks]);
      return inner.check(checks);
    },
  };

  return { seen, limiter };
};

interface AppOptions {
  readonly limiter: RateLimiter;
  readonly tenant: WidgetTenant | undefined;
  readonly limits?: WidgetLimits;
  readonly now?: () => number;
}

/**
 * A widget surface in miniature: the context and error handling the real one
 * has, a stand-in for tenant resolution, and one route per endpoint.
 */
const widgetApp = ({ limiter, tenant, limits = ROOMY, now }: AppOptions) => {
  const app = new Hono<AppEnv>();

  app.use('*', requestContext());
  app.onError(errorHandler);

  app.use('*', async (c, next) => {
    if (tenant !== undefined) c.set('widgetTenant', tenant);

    const session = c.req.header('x-test-session');
    if (session !== undefined) c.set('widgetSessionId', session);

    await next();
  });

  const shared = { limiter, ipSecret: SECRET, limits, ...(now === undefined ? {} : { now }) };

  app.get('/config', limitWidgetRequest({ ...shared, endpoint: 'config' }), (c) =>
    c.json({ ok: true }),
  );
  app.post('/session', limitWidgetRequest({ ...shared, endpoint: 'session' }), (c) =>
    c.json({ ok: true }),
  );
  app.post('/chat', limitWidgetRequest({ ...shared, endpoint: 'chat' }), (c) =>
    c.json({ ok: true }),
  );

  return app;
};

const call = (
  app: ReturnType<typeof widgetApp>,
  route: 'GET /config' | 'POST /session' | 'POST /chat',
  { ip = '203.0.113.7', session }: { ip?: string; session?: string } = {},
) => {
  const [method, path] = route.split(' ') as [string, string];

  return app.request(path, {
    method,
    headers: {
      'x-forwarded-for': ip,
      ...(session === undefined ? {} : { 'x-test-session': session }),
    },
  });
};

describe('each dimension trips on its own', () => {
  it('per session', async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: CANTINA,
      limits: { ...ROOMY, sessionPerMinute: { session: 100, chat: 1 } },
    });

    expect((await call(app, 'POST /chat', { session: 'sid-a' })).status).toBe(200);
    expect((await call(app, 'POST /chat', { session: 'sid-a' })).status).toBe(429);

    // Another visitor on the same address is untouched.
    expect((await call(app, 'POST /chat', { session: 'sid-b' })).status).toBe(200);
  });

  it('per address, within one tenant', async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: CANTINA,
      limits: { ...ROOMY, ipPerMinute: { ...ROOMY.ipPerMinute, config: 1 } },
    });

    expect((await call(app, 'GET /config', { ip: '203.0.113.7' })).status).toBe(200);
    expect((await call(app, 'GET /config', { ip: '203.0.113.7' })).status).toBe(429);
    expect((await call(app, 'GET /config', { ip: '198.51.100.9' })).status).toBe(200);
  });

  it('per tenant per minute, across every endpoint', async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: CANTINA,
      limits: { ...ROOMY, tenantPerMinute: { ...ROOMY.tenantPerMinute, CANTINA: 2 } },
    });

    // Different addresses and sessions, so nothing but the tenant is shared.
    expect((await call(app, 'GET /config', { ip: '198.51.100.1' })).status).toBe(200);
    expect((await call(app, 'POST /chat', { ip: '198.51.100.2', session: 's2' })).status).toBe(200);
    expect((await call(app, 'POST /session', { ip: '198.51.100.3' })).status).toBe(429);
  });

  it('per tenant per minute, at the no-subscription tier when there is no plan', async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: { tenantId: TENANT, plan: null, status: 'TRIALING', locale: 'it' },
      limits: { ...ROOMY, tenantPerMinute: { ...ROOMY.tenantPerMinute, none: 1 } },
    });

    expect((await call(app, 'GET /config', { ip: '198.51.100.1' })).status).toBe(200);
    expect((await call(app, 'GET /config', { ip: '198.51.100.2' })).status).toBe(429);
  });

  it('per endpoint, leaving the others alone', async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: CANTINA,
      limits: { ...ROOMY, endpointPerMinute: { ...ROOMY.endpointPerMinute, chat: 1 } },
    });

    expect((await call(app, 'POST /chat', { ip: '198.51.100.1' })).status).toBe(200);
    expect((await call(app, 'POST /chat', { ip: '198.51.100.2' })).status).toBe(429);
    expect((await call(app, 'GET /config', { ip: '198.51.100.3' })).status).toBe(200);
  });

  it('per month, which only chat spends', async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: CANTINA,
      limits: { ...ROOMY, messagesPerMonth: { ...ROOMY.messagesPerMonth, CANTINA: 1 } },
    });

    expect((await call(app, 'POST /chat', { ip: '198.51.100.1', session: 's1' })).status).toBe(200);
    expect((await call(app, 'POST /chat', { ip: '198.51.100.2', session: 's2' })).status).toBe(429);

    // Page views do not spend a winery's messages.
    expect((await call(app, 'GET /config', { ip: '198.51.100.3' })).status).toBe(200);
  });
});

describe('a refusal', () => {
  it('carries Retry-After and the X-RateLimit headers for a burst limit', async () => {
    const at = Date.UTC(2026, 8, 15, 10, 0, 30);
    const app = widgetApp({
      limiter: memoryRateLimiter(() => at),
      tenant: CANTINA,
      now: () => at,
      limits: { ...ROOMY, ipPerMinute: { ...ROOMY.ipPerMinute, config: 1 } },
    });

    const allowed = await call(app, 'GET /config');
    expect(allowed.status).toBe(200);
    expect(allowed.headers.get('retry-after')).toBeNull();
    expect(allowed.headers.get('x-ratelimit-remaining')).toBeNull();

    const refused = await call(app, 'GET /config');

    expect(refused.status).toBe(429);
    expect(refused.headers.get('retry-after')).toBe('30');
    expect(refused.headers.get('x-ratelimit-limit')).toBe('1');
    expect(refused.headers.get('x-ratelimit-remaining')).toBe('0');
    expect(refused.headers.get('x-ratelimit-reset')).toBe(
      String(Date.UTC(2026, 8, 15, 10, 1, 0) / 1000),
    );
    expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it("keeps the plan cap's numbers out of the headers", async () => {
    const app = widgetApp({
      limiter: memoryRateLimiter(),
      tenant: CANTINA,
      limits: { ...ROOMY, messagesPerMonth: { ...ROOMY.messagesPerMonth, CANTINA: 1 } },
    });

    await call(app, 'POST /chat', { ip: '198.51.100.1' });
    const refused = await call(app, 'POST /chat', { ip: '198.51.100.2' });

    expect(refused.status).toBe(429);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);

    // A limit of 1000 would name the plan a winery pays for (§1.3).
    expect(refused.headers.get('x-ratelimit-limit')).toBeNull();
    expect(refused.headers.get('x-ratelimit-remaining')).toBeNull();
    expect(refused.headers.get('x-ratelimit-reset')).toBeNull();
  });
});

describe('the address bucket', () => {
  it('never puts the address in a key', async () => {
    const { seen, limiter } = recording();
    const app = widgetApp({ limiter, tenant: CANTINA });

    await call(app, 'POST /chat', { ip: '198.51.100.42', session: 's1' });

    const keys = seen.flat().map((check) => check.key);
    expect(keys.some((key) => key.includes('198.51.100.42'))).toBe(false);
    expect(keys.filter((key) => key.startsWith('ip:'))).toHaveLength(1);
  });

  it('keeps one bucket per address within a day, and starts a new one the next', async () => {
    let at = Date.UTC(2026, 8, 15, 23, 58);
    const { seen, limiter } = recording();
    const app = widgetApp({ limiter, tenant: CANTINA, now: () => at });

    await call(app, 'GET /config');
    await call(app, 'GET /config');
    at = Date.UTC(2026, 8, 16, 0, 1);
    await call(app, 'GET /config');

    const ipKeys = seen.map((checks) => checks.find((check) => check.key.startsWith('ip:'))?.key);
    expect(ipKeys[0]).toBeDefined();
    expect(ipKeys[1]).toBe(ipKeys[0]);
    expect(ipKeys[2]).not.toBe(ipKeys[0]);
  });
});

describe('before the key and origin are resolved (review fix)', () => {
  /** The address limit, then a stand-in for resolution that counts how often it ran. */
  const unresolvedApp = (limiter: RateLimiter, unresolvedPerMinute = 100) => {
    const resolutions = { count: 0 };
    const app = new Hono<AppEnv>();

    app.use('*', requestContext());
    app.onError(errorHandler);
    app.get(
      '/config',
      limitUnresolvedWidgetRequest({
        limiter,
        ipSecret: SECRET,
        limits: { ...ROOMY, unresolvedPerMinute },
      }),
      (c) => {
        resolutions.count += 1;
        return c.json({ ok: true });
      },
    );

    return { app, resolutions };
  };

  const get = (app: Hono<AppEnv>, ip = '203.0.113.7') =>
    app.request('/config', { headers: { 'x-forwarded-for': ip } });

  it('refuses an address past its limit before anything is resolved', async () => {
    const { app, resolutions } = unresolvedApp(memoryRateLimiter(), 2);

    expect((await get(app)).status).toBe(200);
    expect((await get(app)).status).toBe(200);
    const refused = await get(app);

    expect(refused.status).toBe(429);
    expect(resolutions.count).toBe(2);
    expect(Number(refused.headers.get('retry-after'))).toBeGreaterThanOrEqual(1);
    // CORS never ran, so nothing is allowed — but a route the edge caches still varies on Origin.
    expect(refused.headers.get('vary')).toContain('Origin');
    expect(refused.headers.get('access-control-allow-origin')).toBeNull();
    expect(await refused.json()).toMatchObject({ error: { code: 'rate_limited' } });
  });

  it('counts each address on its own', async () => {
    const { app } = unresolvedApp(memoryRateLimiter(), 1);

    expect((await get(app, '203.0.113.7')).status).toBe(200);
    expect((await get(app, '203.0.113.7')).status).toBe(429);
    expect((await get(app, '198.51.100.9')).status).toBe(200);
  });

  it('draws one bucket, keyed on the address HMAC and on no tenant', async () => {
    const { seen, limiter } = recording();
    const { app } = unresolvedApp(limiter);

    await get(app, '198.51.100.42');

    const [only] = seen;
    expect(only).toHaveLength(1);
    expect(only?.[0]?.key).toMatch(/^ip:[0-9a-f]{32}:unresolved$/);
    expect(only?.[0]?.key).not.toContain('198.51.100.42');
  });
});

describe('wiring', () => {
  it('refuses to run before the tenant is resolved, and consults nothing', async () => {
    const { seen, limiter } = recording();
    const app = widgetApp({ limiter, tenant: undefined });

    const response = await call(app, 'GET /config');

    // A wiring bug, not a request problem: a generic 500, and no bucket touched.
    expect(response.status).toBe(500);
    expect(seen).toHaveLength(0);
  });

  it('asks for every dimension of a chat request in a single check', async () => {
    const { seen, limiter } = recording();
    const app = widgetApp({ limiter, tenant: CANTINA });

    await call(app, 'POST /chat', { session: 'sid-1' });

    expect(seen).toHaveLength(1);
    expect(seen[0]?.map((check) => check.key.split(':')[0])).toEqual([
      'session',
      'ip',
      'tenant',
      'endpoint',
      'tenant',
    ]);
    expect(seen[0]?.at(-1)).toMatchObject({ key: `tenant:${TENANT}:month`, window: 'month' });
  });
});
