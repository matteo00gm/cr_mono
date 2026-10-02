import { RANGE_EXPECTED } from '@catalogorosso/core';
import type { RefusedOrigin, RefusedOriginsQuery } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  createAnalyticsPort,
  unconfiguredAnalytics,
  type AnalyticsPort,
} from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The sites refused for a winery's key (P6-05): the port, and the route
 * every member can read. Adding one is `POST /domains`, tested where it lives.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-01T15:30:00.000Z');

const ORIGINS: RefusedOrigin[] = [
  {
    origin: 'https://shop.cantina.example',
    attempts: 212,
    sources: 37,
    lastSeenAt: new Date('2026-09-30T19:12:00.000Z'),
    domainStatus: null,
  },
  {
    origin: 'https://www.cantina.example',
    attempts: 3,
    sources: 1,
    lastSeenAt: new Date('2026-09-29T08:00:00.000Z'),
    domainStatus: 'PENDING',
  },
];

const reading = () => {
  const asked: [string, RefusedOriginsQuery][] = [];
  const port = createAnalyticsPort({
    now: () => NOW,
    readRefusedOrigins: (tenantId, query) => {
      asked.push([tenantId, query]);
      return Promise.resolve(ORIGINS);
    },
  });

  return { asked, port };
};

describe('the port', () => {
  it('asks for fifty at most, over the range asked', async () => {
    const { asked, port } = reading();

    await port.refusedOrigins(TENANT, { from: '2026-09-01', to: '2026-09-30' });

    expect(asked).toEqual([
      [
        TENANT,
        {
          start: new Date('2026-09-01T00:00:00.000Z'),
          end: new Date('2026-10-01T00:00:00.000Z'),
          limit: 50,
        },
      ],
    ]);
  });

  it('answers with each site and what the winery has done about it', async () => {
    const { port } = reading();

    expect(await port.refusedOrigins(TENANT, {})).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      origins: [
        {
          origin: 'https://shop.cantina.example',
          attempts: 212,
          sources: 37,
          lastSeenAt: '2026-09-30T19:12:00.000Z',
          domain: null,
        },
        {
          origin: 'https://www.cantina.example',
          attempts: 3,
          sources: 1,
          lastSeenAt: '2026-09-29T08:00:00.000Z',
          domain: 'PENDING',
        },
      ],
    });
  });

  it('refuses a range that is not one before asking the store', async () => {
    const { asked, port } = reading();

    await expect(port.refusedOrigins(TENANT, { to: 'ieri' })).rejects.toThrow(RANGE_EXPECTED);
    expect(asked).toEqual([]);
  });

  it('with nothing behind it, refuses loudly rather than reporting no attempts', async () => {
    await expect(unconfiguredAnalytics.refusedOrigins(TENANT, {})).rejects.toThrow(/wiring bug/u);
  });
});

describe('the route', () => {
  const get = (path: string, role: 'OWNER' | 'EDITOR' = 'OWNER') => {
    const asked: [string, unknown][] = [];
    const analytics: AnalyticsPort = {
      funnel: () => Promise.reject(new Error('not this route')),
      top: () => Promise.reject(new Error('not this route')),
      zeroResults: () => Promise.reject(new Error('not this route')),
      refusedOrigins: (tenantId, range) => {
        asked.push([tenantId, range]);
        return reading().port.refusedOrigins(tenantId, range);
      },
    };
    const response = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, role),
      analytics,
    }).request(path);

    return { asked, response };
  };

  it.each(['OWNER', 'EDITOR'] as const)(
    'answers %s: an editor is often the one who notices',
    async (role) => {
      const { asked, response } = get('/v1/dashboard/analytics/origins', role);

      expect((await response).status).toBe(200);
      expect(asked.map(([tenantId]) => tenantId)).toEqual([TENANT]);
    },
  );

  it('passes the days asked for, and nothing else', async () => {
    const { asked, response } = get(
      '/v1/dashboard/analytics/origins?from=2026-09-01&to=2026-09-07&tenantId=x',
    );

    expect((await response).status).toBe(200);
    expect(asked).toEqual([[TENANT, { from: '2026-09-01', to: '2026-09-07' }]]);
  });

  it('refuses a range that is not one with a 422', async () => {
    const response = await get('/v1/dashboard/analytics/origins?from=2026-02-30').response;

    expect(response.status).toBe(422);
  });
});
