import { RANGE_EXPECTED } from '@catalogorosso/core';
import type { AttributedSales, SalesQuery } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  createAnalyticsPort,
  unconfiguredAnalytics,
  type AnalyticsPort,
} from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { fakeAuth, oneMembership, signedIn } from './support/auth.js';

/**
 * What the sommelier sold, and whether a sale can be seen at all (P6-10): the
 * port, and the route every member can read.
 *
 * **`hasOrderAttribution` is the whole of this row.** Every revenue word on
 * the dashboard hangs on it, so what makes it true — a shop is connected —
 * and what it is when nothing can be measured are pinned here, where it is
 * decided, rather than on each screen that reads it.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-01T15:30:00.000Z');

const SOLD: AttributedSales = {
  orders: 31,
  visits: 29,
  units: 74,
  amounts: [{ currency: 'EUR', cents: 286_450 }],
};

/** A word, not `undefined`: passed to a defaulted parameter, `undefined` would mean "the default". */
const NO_SHOP = 'no-shop';

const reading = (sold: AttributedSales | typeof NO_SHOP = SOLD) => {
  const asked: [string, SalesQuery][] = [];
  const port = createAnalyticsPort({
    now: () => NOW,
    readSales: (tenantId, query) => {
      asked.push([tenantId, query]);
      return Promise.resolve(sold === NO_SHOP ? undefined : sold);
    },
  });

  return { asked, port };
};

describe('the port', () => {
  it('asks for the range asked, as whole UTC days', async () => {
    const { asked, port } = reading();

    await port.sales(TENANT, { from: '2026-09-01', to: '2026-09-30' });

    expect(asked).toEqual([
      [
        TENANT,
        { start: new Date('2026-09-01T00:00:00.000Z'), end: new Date('2026-10-01T00:00:00.000Z') },
      ],
    ]);
  });

  it('says sales can be seen, and what was sold, for a winery with a shop connected', async () => {
    const { port } = reading();

    expect(await port.sales(TENANT, {})).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      hasOrderAttribution: true,
      orders: 31,
      visits: 29,
      units: 74,
      amounts: [{ currency: 'EUR', cents: 286_450 }],
    });
  });

  it('says sales cannot be seen for a winery with no shop, and gives it noughts', async () => {
    /* Not "none sold": not measured. The flag is what tells a screen the difference. */
    const { port } = reading(NO_SHOP);

    expect(await port.sales(TENANT, {})).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      hasOrderAttribution: false,
      orders: 0,
      visits: 0,
      units: 0,
      amounts: [],
    });
  });

  it('says sales can be seen for a connected winery that has sold nothing yet', async () => {
    /* Measured, and none: a true nought, which is a different thing from the one above. */
    const { port } = reading({ orders: 0, visits: 0, units: 0, amounts: [] });

    expect(await port.sales(TENANT, {})).toMatchObject({
      hasOrderAttribution: true,
      orders: 0,
      amounts: [],
    });
  });

  it('keeps each currency apart, as the store gave them', async () => {
    const { port } = reading({
      ...SOLD,
      amounts: [
        { currency: 'EUR', cents: 286_450 },
        { currency: 'CHF', cents: 12_000 },
      ],
    });

    expect((await port.sales(TENANT, {})).amounts).toEqual([
      { currency: 'EUR', cents: 286_450 },
      { currency: 'CHF', cents: 12_000 },
    ]);
  });

  it('refuses a range that is not one before asking the store', async () => {
    const { asked, port } = reading();

    await expect(port.sales(TENANT, { to: 'ieri' })).rejects.toThrow(RANGE_EXPECTED);
    expect(asked).toEqual([]);
  });

  it('with nothing behind it, refuses loudly rather than reporting no sales', async () => {
    await expect(unconfiguredAnalytics.sales(TENANT, {})).rejects.toThrow(/wiring bug/u);
  });
});

describe('the route', () => {
  const get = (path: string, role: 'OWNER' | 'EDITOR' = 'OWNER') => {
    const asked: [string, unknown][] = [];
    const analytics: AnalyticsPort = {
      funnel: () => Promise.reject(new Error('not this route')),
      top: () => Promise.reject(new Error('not this route')),
      zeroResults: () => Promise.reject(new Error('not this route')),
      refusedOrigins: () => Promise.reject(new Error('not this route')),
      sales: (tenantId, range) => {
        asked.push([tenantId, range]);
        return reading().port.sales(tenantId, range);
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
    'answers %s, for the winery of the membership',
    async (role) => {
      const { asked, response } = get('/v1/dashboard/analytics/sales', role);

      expect((await response).status).toBe(200);
      expect(await (await response).json()).toMatchObject({
        hasOrderAttribution: true,
        orders: 31,
      });
      expect(asked.map(([tenantId]) => tenantId)).toEqual([TENANT]);
    },
  );

  it('passes the days asked for, and nothing else', async () => {
    const { asked, response } = get(
      '/v1/dashboard/analytics/sales?from=2026-09-01&to=2026-09-07&tenantId=x',
    );

    expect((await response).status).toBe(200);
    expect(asked).toEqual([[TENANT, { from: '2026-09-01', to: '2026-09-07' }]]);
  });

  it('refuses a range that is not one with a 422', async () => {
    const response = await get('/v1/dashboard/analytics/sales?from=2026-02-30').response;

    expect(response.status).toBe(422);
  });

  it('is refused without a session, before the port is asked anything', async () => {
    const asked: string[] = [];
    const response = await createApp({
      auth: fakeAuth(),
      readMemberships: oneMembership(TENANT),
      analytics: {
        ...unconfiguredAnalytics,
        sales: (tenantId) => {
          asked.push(tenantId);
          return reading().port.sales(tenantId, {});
        },
      },
    }).request('/v1/dashboard/analytics/sales');

    expect(response.status).toBe(401);
    expect(asked).toEqual([]);
  });
});
