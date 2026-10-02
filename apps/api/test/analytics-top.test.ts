import { RANGE_EXPECTED } from '@catalogorosso/core';
import type { TopProduct, TopProductsQuery, TopQueriesQuery, TopQuery } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  createAnalyticsPort,
  unconfiguredAnalytics,
  type AnalyticsPort,
} from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The top questions and wines (P6-03, §2.4): the port that reads both in one
 * scope and says what they mean, and the route every member can read.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-01T15:30:00.000Z');
const BAROLO = '9b2f4c1e-6a3d-4e8b-9f10-2c7d5e8a1b34';
const GONE = '0c6f1d2a-5b4e-4c3d-8a9b-7e6f5d4c3b2a';

const QUERIES: TopQuery[] = [
  {
    query: 'un rosso per la bistecca',
    conversations: 14,
    lastAskedAt: new Date('2026-09-30T19:12:00.000Z'),
  },
];

const PRODUCTS: TopProduct[] = [
  { productId: BAROLO, name: 'Barolo', archived: false, recommended: 40, added: 6 },
  { productId: GONE, name: null, archived: false, recommended: 4, added: 0 },
];

const reading = (queries = QUERIES, products = PRODUCTS) => {
  const asked: [string, TopQueriesQuery, TopProductsQuery][] = [];
  const port = createAnalyticsPort({
    now: () => NOW,
    readTop: (tenantId, queriesQuery, productsQuery) => {
      asked.push([tenantId, queriesQuery, productsQuery]);
      return Promise.resolve({ queries, products });
    },
  });

  return { asked, port };
};

describe('the port', () => {
  it('asks for three conversations at least and ten of each, over the range asked', async () => {
    const { asked, port } = reading();

    await port.top(TENANT, { from: '2026-09-01', to: '2026-09-30' });

    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-10-01T00:00:00.000Z');

    expect(asked).toEqual([
      [TENANT, { start, end, minConversations: 3, limit: 10 }, { start, end, limit: 10 }],
    ]);
  });

  it('answers with the questions and the wines, and each wine’s conversion', async () => {
    const { port } = reading();

    expect(await port.top(TENANT, {})).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      queries: [
        {
          query: 'un rosso per la bistecca',
          conversations: 14,
          lastAskedAt: '2026-09-30T19:12:00.000Z',
        },
      ],
      products: [
        {
          productId: BAROLO,
          name: 'Barolo',
          archived: false,
          recommended: 40,
          addedToCart: 6,
          rate: 0.15,
        },
        { productId: GONE, name: null, archived: false, recommended: 4, addedToCart: 0, rate: 0 },
      ],
    });
  });

  it('refuses a range that is not one before asking the store', async () => {
    const { asked, port } = reading();

    await expect(port.top(TENANT, { to: 'ieri' })).rejects.toThrow(RANGE_EXPECTED);
    expect(asked).toEqual([]);
  });

  it('with nothing behind it, refuses loudly rather than answering empty lists', async () => {
    await expect(unconfiguredAnalytics.top(TENANT, {})).rejects.toThrow(/wiring bug/u);
  });
});

describe('the route', () => {
  const get = (path: string, role: 'OWNER' | 'EDITOR' = 'OWNER') => {
    const asked: [string, unknown][] = [];
    const analytics: AnalyticsPort = {
      funnel: () => Promise.reject(new Error('not this route')),
      zeroResults: () => Promise.reject(new Error('not this route')),
      refusedOrigins: () => Promise.reject(new Error('not this route')),
      top: (tenantId, range) => {
        asked.push([tenantId, range]);
        return reading().port.top(tenantId, range);
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
    'answers %s: every member reads analytics',
    async (role) => {
      const { asked, response } = get('/v1/dashboard/analytics/top', role);

      expect((await response).status).toBe(200);
      expect(asked.map(([tenantId]) => tenantId)).toEqual([TENANT]);
    },
  );

  it('passes the days asked for, and nothing else', async () => {
    const { asked, response } = get(
      `/v1/dashboard/analytics/top?from=2026-09-01&to=2026-09-07&tenantId=${'2'.repeat(8)}`,
    );

    expect((await response).status).toBe(200);
    expect(asked).toEqual([[TENANT, { from: '2026-09-01', to: '2026-09-07' }]]);
  });

  it('refuses a range that is not one with a 422 saying what is wanted', async () => {
    const response = await get('/v1/dashboard/analytics/top?from=2026-09-07&to=2026-09-01')
      .response;

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('YYYY-MM-DD');
  });
});
