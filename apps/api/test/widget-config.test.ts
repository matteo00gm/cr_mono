import { randomUUID } from 'node:crypto';
import { widgetConfigResponse } from '@catalogorosso/api-client';
import type { WidgetResolution } from '@catalogorosso/db';
import {
  memoryRateLimiter,
  planCapCheck,
  type LimitCheck,
  type MonthlyCheck,
  type RateLimiter,
} from '@catalogorosso/security';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { assertEveryRouteDeclared, UndeclaredRouteError } from '../src/middleware/capability.js';
import { WIDGET_PREFIX } from '../src/routes.js';
import {
  WIDGET_CONFIG_CACHE_CONTROL,
  WIDGET_ROUTE_ACCESS,
  type WidgetDependencies,
} from '../src/surfaces/widget.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * `GET /v1/widget/config` (P2-10).
 *
 * Through the real app, with the widget's dependencies faked: CORS decides,
 * the limit counts, and the handler returns only what may be world-readable.
 * Every assertion the row asks for is here — no tenant id or plan in the shape,
 * the cache headers, a disabled tenant reported as disabled, an unverified
 * origin refused — plus the order that makes those true.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://cantina-rossi.example';

/** Assembled at runtime, never written as a literal (P0-56). */
const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

type Found = Extract<WidgetResolution, { found: true }>;

const found = (overrides: Partial<Found> = {}): Found => ({
  found: true,
  tenantId: TENANT,
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
  ...overrides,
});

const UNKNOWN: WidgetResolution = { found: false, reason: 'unknown_key' };

const widget = (overrides: Partial<WidgetDependencies> = {}): WidgetDependencies => ({
  resolve: (key, origin) => Promise.resolve(key === KEY && origin === ORIGIN ? found() : UNKNOWN),
  limiter: memoryRateLimiter(),
  readUsage: () => Promise.resolve(0),
  ipSecret: randomUUID(),
  ...overrides,
});

const app = (overrides: Partial<WidgetDependencies> = {}) =>
  createApp({ auth: fakeAuth(), readMemberships: oneMembership(), widget: widget(overrides) });

const getConfig = (
  built: ReturnType<typeof app>,
  {
    origin = ORIGIN,
    key = KEY,
    method = 'GET',
  }: { origin?: string; key?: string; method?: string } = {},
) =>
  built.request(`/v1/widget/config?key=${encodeURIComponent(key)}`, {
    method,
    headers: { origin, 'x-forwarded-for': '203.0.113.7' },
  });

describe('the response', () => {
  it('is exactly the public shape, with no tenant id, plan or count anywhere', async () => {
    const response = await getConfig(app());

    expect(response.status).toBe(200);

    const body: unknown = await response.json();

    // Strict: a field the contract does not name fails here.
    expect(widgetConfigResponse.parse(body)).toEqual({
      status: 'ACTIVE',
      locale: 'it',
      theme: { primaryColor: '#7b1e3a', position: 'bottom-right', avatarUrl: null },
      welcomeMessage: 'Ciao! Sono il sommelier di questa cantina. Che vino stai cercando?',
      cartUrl: '/cart',
      quotaState: 'ok',
    });
    expect(JSON.stringify(body)).not.toContain(TENANT);
    expect(JSON.stringify(body)).not.toContain('CANTINA');
  });

  it('greets in the tenant’s locale', async () => {
    const english = app({ resolve: () => Promise.resolve(found({ locale: 'en' })) });

    const body = widgetConfigResponse.parse(await (await getConfig(english)).json());

    expect(body.locale).toBe('en');
    expect(body.welcomeMessage).toMatch(/^Hello!/);
  });

  it.each<[Found['status'], 'ACTIVE' | 'DISABLED']>([
    ['ACTIVE', 'ACTIVE'],
    ['TRIALING', 'ACTIVE'],
    ['PAST_DUE', 'DISABLED'],
    ['DISABLED', 'DISABLED'],
    ['CANCELED', 'DISABLED'],
    ['PENDING_VERIFICATION', 'DISABLED'],
  ])('reports a tenant that is %s as %s, and never the billing detail', async (status, shown) => {
    const built = app({ resolve: () => Promise.resolve(found({ status })) });

    const body = widgetConfigResponse.parse(await (await getConfig(built)).json());

    expect(body.status).toBe(shown);
  });
});

describe('the quota', () => {
  it.each<[number, 'ok' | 'near' | 'exceeded']>([
    [0, 'ok'],
    [799, 'ok'],
    [800, 'near'],
    [1_000, 'exceeded'],
  ])('reads %i of a CANTINA month as %s', async (used, state) => {
    const built = app({ readUsage: () => Promise.resolve(used) });

    const body = widgetConfigResponse.parse(await (await getConfig(built)).json());

    expect(body.quotaState).toBe(state);
  });

  it('reads the month through the same plan-cap check chat spends', async () => {
    const asked: MonthlyCheck[] = [];
    const built = app({
      readUsage: (check) => {
        asked.push(check);
        return Promise.resolve(0);
      },
    });

    await getConfig(built);

    expect(asked).toEqual([planCapCheck(TENANT, 'CANTINA')]);
  });

  it('counts a fetch against the config tier, and never against the month', async () => {
    /*
     * Config is fetched on every page view. Counted as chat, it would spend a
     * winery's messages on visitors who never opened the widget.
     */
    const counted: LimitCheck[][] = [];
    const built = app({
      limiter: {
        check: (limits) => {
          counted.push([...limits]);
          return memoryRateLimiter().check(limits);
        },
      },
    });

    await getConfig(built);

    const [checks = []] = counted;
    expect(counted).toHaveLength(1);
    expect(checks.map((check) => check.key)).toContain(`endpoint:config:${TENANT}`);
    expect(checks.some((check) => 'window' in check)).toBe(false);
  });
});

describe('caching', () => {
  it('lets a 200 be cached publicly for a minute, varying on Origin', async () => {
    const response = await getConfig(app());

    expect(response.headers.get('cache-control')).toBe(WIDGET_CONFIG_CACHE_CONTROL);
    expect(WIDGET_CONFIG_CACHE_CONTROL).toBe('public, max-age=60');
    expect(response.headers.get('vary')).toContain('Origin');
  });

  it('never marks a refusal cacheable', async () => {
    const response = await getConfig(app(), { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(response.headers.get('cache-control') ?? '').not.toContain('public');
  });
});

describe('the order: CORS, then the limit, then the handler', () => {
  it('refuses an unverified origin before counting or reading anything', async () => {
    let checks = 0;
    let reads = 0;
    const built = app({
      limiter: {
        check: (limits) => {
          checks += 1;
          return memoryRateLimiter().check(limits);
        },
      },
      readUsage: () => {
        reads += 1;
        return Promise.resolve(0);
      },
    });

    const response = await getConfig(built, { origin: 'https://evil.example' });

    expect(response.status).toBe(403);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
    expect([checks, reads]).toEqual([0, 0]);
  });

  it('answers a preflight from CORS alone', async () => {
    let checks = 0;
    const built = app({
      limiter: {
        check: (limits) => {
          checks += 1;
          return memoryRateLimiter().check(limits);
        },
      },
    });

    const response = await getConfig(built, { method: 'OPTIONS' });

    expect(response.status).toBe(204);
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(checks).toBe(0);
  });

  it('carries the CORS headers on a 429, so the widget can read its Retry-After', async () => {
    const refusing: RateLimiter = {
      check: () =>
        Promise.resolve({
          allowed: false,
          remaining: 0,
          resetAt: new Date(Date.now() + 30_000),
          limit: 60,
          key: 'ip:bucket:tenant:config',
          retryAfterSec: 30,
        }),
    };

    const response = await getConfig(app({ limiter: refusing }));

    expect(response.status).toBe(429);
    expect(response.headers.get('retry-after')).toBe('30');
    expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
    expect(response.headers.get('access-control-expose-headers')).toContain('Retry-After');
  });
});

describe('wiring', () => {
  it('fails loudly when no widget dependencies were supplied, and keeps the marker', async () => {
    const bare = createApp({ auth: fakeAuth(), readMemberships: oneMembership() });

    expect((await getConfig(bare)).status).toBe(500);
    expect(await (await bare.request('/v1/widget')).json()).toEqual({ surface: 'widget' });
  });

  it('declares every widget route, so one added without a declaration fails at boot', () => {
    const built = app();

    expect(() => {
      assertEveryRouteDeclared(built, WIDGET_ROUTE_ACCESS, WIDGET_PREFIX);
    }).not.toThrow();
    expect(() => {
      assertEveryRouteDeclared(built, new Map(), WIDGET_PREFIX);
    }).toThrow(UndeclaredRouteError);
  });
});
