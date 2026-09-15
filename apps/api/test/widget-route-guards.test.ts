import { randomUUID } from 'node:crypto';
import type { WidgetResolution } from '@catalogorosso/db';
import { memoryRateLimiter, type RateLimiter } from '@catalogorosso/security';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { routeKey } from '../src/middleware/capability.js';
import { WIDGET_PREFIX } from '../src/routes.js';
import { WIDGET_ROUTE_ACCESS, type WidgetDependencies } from '../src/surfaces/widget.js';
import { fakeAuth, oneMembership } from './support/auth.js';

/**
 * Every widget route behind its three guards, in order (review fix; `AGENTS.md`).
 *
 * **It walks the route table rather than naming routes.** A route mounted by
 * hand can drop a guard or reorder two while its own tests all pass, because
 * those tests are about what the route does, not about what stands in front of
 * it. Iterating `WIDGET_ROUTE_ACCESS` holds P2-12's session route and P2-29's
 * chat route to the order the day they are declared, with no one remembering to
 * add a case.
 *
 * Each case is a request one guard must stop before the next layer runs:
 * - an exhausted address, before the key is resolved;
 * - an unknown key, before anything is counted against a tenant;
 * - an exhausted tenant, after CORS has resolved it.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';
const ORIGIN = 'https://cantina-rossi.example';

/** Assembled at runtime, never written as a literal (P0-56). */
const KEY = ['pk', 'test', randomUUID().replaceAll('-', '')].join('_');

const FOUND: WidgetResolution = {
  found: true,
  tenantId: TENANT,
  status: 'ACTIVE',
  plan: 'CANTINA',
  locale: 'it',
};
const UNKNOWN: WidgetResolution = { found: false, reason: 'unknown_key' };

const isAddressOnly = (key: string): boolean => key.endsWith(':unresolved');

/** Refuses any check `refuses` picks out, and counts the rest for real, recording every key asked about. */
const limiterRefusing = (refuses: (key: string) => boolean) => {
  const asked: string[] = [];
  const limiter: RateLimiter = {
    check: (checks) => {
      asked.push(...checks.map((check) => check.key));
      return checks.some((check) => refuses(check.key))
        ? Promise.resolve({
            allowed: false,
            remaining: 0,
            resetAt: new Date(Date.now() + 10_000),
            limit: 1,
            key: checks[0]?.key ?? '',
            retryAfterSec: 10,
          })
        : memoryRateLimiter().check(checks);
    },
  };
  return { asked, limiter };
};

const appWith = (overrides: Partial<WidgetDependencies>) =>
  createApp({
    auth: fakeAuth(),
    readMemberships: oneMembership(),
    widget: {
      resolve: () => Promise.resolve(FOUND),
      limiter: memoryRateLimiter(),
      readUsage: () => Promise.resolve(0),
      ipSecret: randomUUID(),
      ...overrides,
    },
  });

/** Only the surface marker is exempt: it resolves nothing and answers the same to everyone. */
const MARKER = routeKey('GET', WIDGET_PREFIX);
const GUARDED = [...WIDGET_ROUTE_ACCESS.keys()].filter((key) => key !== MARKER);

describe('the widget route table', () => {
  it('has guarded routes to walk, or every case below is vacuous', () => {
    expect(GUARDED.length).toBeGreaterThan(0);
  });
});

describe.each(GUARDED)('%s', (key) => {
  const [method = '', path = ''] = key.split(' ');

  const send = (built: ReturnType<typeof appWith>) =>
    built.request(`${path}?key=${encodeURIComponent(KEY)}`, {
      method,
      headers: { origin: ORIGIN, 'x-forwarded-for': '203.0.113.7' },
    });

  it('refuses an exhausted address before resolving the key', async () => {
    let resolutions = 0;
    const { limiter } = limiterRefusing(isAddressOnly);
    const built = appWith({
      limiter,
      resolve: () => {
        resolutions += 1;
        return Promise.resolve(FOUND);
      },
    });

    const response = await send(built);

    expect(response.status).toBe(429);
    expect(resolutions).toBe(0);
    expect(response.headers.get('access-control-allow-origin')).toBeNull();
  });

  it('refuses an unknown key having counted only the address', async () => {
    const { asked, limiter } = limiterRefusing(() => false);
    const built = appWith({ limiter, resolve: () => Promise.resolve(UNKNOWN) });

    const response = await send(built);

    expect(response.status).toBe(403);
    expect(asked).toHaveLength(1);
    expect(asked.every(isAddressOnly)).toBe(true);
  });

  if (method === 'OPTIONS') {
    it('answers a preflight from CORS, never reaching the tenant’s limits', async () => {
      const { asked, limiter } = limiterRefusing((checkKey) => !isAddressOnly(checkKey));

      const response = await send(appWith({ limiter }));

      expect(response.status).toBe(204);
      expect(asked.every(isAddressOnly)).toBe(true);
    });
  } else {
    it('counts the tenant after CORS resolved it, so its refusal carries the CORS headers', async () => {
      const { asked, limiter } = limiterRefusing((checkKey) => !isAddressOnly(checkKey));

      const response = await send(appWith({ limiter }));

      expect(response.status).toBe(429);
      expect(response.headers.get('access-control-allow-origin')).toBe(ORIGIN);
      expect(asked.some((checkKey) => checkKey.includes(TENANT))).toBe(true);
    });
  }
});
