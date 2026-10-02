import { RANGE_EXPECTED } from '@catalogorosso/core';
import type { FunnelQuery } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import {
  AnalyticsPortNotConfiguredError,
  createAnalyticsPort,
  unconfiguredAnalytics,
  type AnalyticsPort,
} from '../src/analytics.js';
import { createApp } from '../src/app.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The funnel (P6-02, §2.4): the port that joins the store's counts to core's
 * meaning of them, and the route every member can read.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-01T15:30:00.000Z');

const reading = (counts: number[]) => {
  const asked: [string, FunnelQuery][] = [];
  const port = createAnalyticsPort({
    now: () => NOW,
    readFunnel: (tenantId, query) => {
      asked.push([tenantId, query]);
      return Promise.resolve(counts);
    },
  });

  return { asked, port };
};

describe('the port', () => {
  it('reads the four stages, in order, over the range asked', async () => {
    const { asked, port } = reading([200, 80, 60, 15]);

    await port.funnel(TENANT, { from: '2026-09-01', to: '2026-09-30' });

    expect(asked).toEqual([
      [
        TENANT,
        {
          stages: ['WIDGET_OPEN', 'MESSAGE_SENT', 'RECOMMENDATION_SHOWN', 'ADD_TO_CART'],
          start: new Date('2026-09-01T00:00:00.000Z'),
          end: new Date('2026-10-01T00:00:00.000Z'),
        },
      ],
    ]);
  });

  it('answers with the days counted and each step', async () => {
    const { port } = reading([200, 80, 60, 15]);

    expect(await port.funnel(TENANT, {})).toEqual({
      from: '2026-09-02',
      to: '2026-10-01',
      stages: [
        { stage: 'WIDGET_OPEN', sessions: 200, rate: null },
        { stage: 'MESSAGE_SENT', sessions: 80, rate: 0.4 },
        { stage: 'RECOMMENDATION_SHOWN', sessions: 60, rate: 0.75 },
        { stage: 'ADD_TO_CART', sessions: 15, rate: 0.25 },
      ],
    });
  });

  it('reads a stage the store did not answer for as nobody', async () => {
    const { port } = reading([5]);

    const { stages } = await port.funnel(TENANT, {});

    expect(stages.map((step) => step.sessions)).toEqual([5, 0, 0, 0]);
  });

  it('refuses a range that is not one before asking the store', async () => {
    const { asked, port } = reading([]);

    await expect(port.funnel(TENANT, { from: '2026-10-02', to: '2026-10-01' })).rejects.toThrow(
      RANGE_EXPECTED,
    );
    expect(asked).toEqual([]);
  });

  it('with nothing behind it, refuses loudly rather than answering an empty funnel', async () => {
    await expect(unconfiguredAnalytics.funnel(TENANT, {})).rejects.toBeInstanceOf(
      AnalyticsPortNotConfiguredError,
    );
  });
});

describe('the route', () => {
  const get = (path: string, role: 'OWNER' | 'EDITOR' = 'OWNER') => {
    const asked: [string, unknown][] = [];
    const analytics: AnalyticsPort = {
      funnel: (tenantId, range) => {
        asked.push([tenantId, range]);
        return reading([10, 5, 4, 1]).port.funnel(tenantId, range);
      },
      top: () => Promise.reject(new Error('not this route')),
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
      const { asked, response } = get('/v1/dashboard/analytics/funnel', role);

      expect((await response).status).toBe(200);
      expect(asked.map(([tenantId]) => tenantId)).toEqual([TENANT]);
    },
  );

  it('passes the days asked for, and answers with the funnel', async () => {
    const { asked, response } = get('/v1/dashboard/analytics/funnel?from=2026-09-01&to=2026-09-07');
    const body = (await (await response).json()) as { from: string; to: string };

    expect(asked[0]?.[1]).toEqual({ from: '2026-09-01', to: '2026-09-07' });
    expect(body).toMatchObject({ from: '2026-09-01', to: '2026-09-07' });
  });

  it('reads the winery from the membership, never from the query (P0-48)', async () => {
    const { asked, response } = get(
      '/v1/dashboard/analytics/funnel?tenantId=22222222-2222-2222-2222-222222222222',
    );

    expect((await response).status).toBe(200);
    expect(asked.map(([tenantId]) => tenantId)).toEqual([TENANT]);
  });

  it.each([
    ['backwards', '?from=2026-09-07&to=2026-09-01'],
    ['not a day', '?to=yesterday'],
    ['too long to be a day', `?from=${'2'.repeat(11)}`],
  ])('refuses a range that is %s with a 422 saying what is wanted', async (_label, query) => {
    const response = await get(`/v1/dashboard/analytics/funnel${query}`).response;

    expect(response.status).toBe(422);
    expect(JSON.stringify(await response.json())).toContain('YYYY-MM-DD');
  });
});
