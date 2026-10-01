import { NotFoundError } from '@catalogorosso/core';
import type { UsageBreakdown } from '@catalogorosso/db';
import { describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createBillingPort, type BillingPort, type MonthRead } from '../src/billing.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * The month as a seller reads it (P5-12, §2.3): the meter's numbers, computed
 * from the ledger the gate counts, and the route every member can read.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const NOW = new Date('2026-10-11T00:00:00Z');

const EMPTY: UsageBreakdown = { byDay: [], byOrigin: [] };

const month = (overrides: Partial<MonthRead> = {}): MonthRead => ({
  state: {
    status: 'ACTIVE',
    plan: 'CANTINA',
    stripeCustomerId: 'cus_1',
    stripeSubscriptionId: 'sub_1',
    locale: 'it',
  },
  used: 400,
  purchased: 0,
  breakdown: EMPTY,
  ...overrides,
});

const portReading = (read: MonthRead | undefined) => {
  const asked: [string, string][] = [];
  const port = createBillingPort({
    dashboardOrigin: 'https://app.catalogorosso.com',
    now: () => NOW,
    readMonth: (tenantId, period) => {
      asked.push([tenantId, period]);
      return Promise.resolve(read);
    },
  });

  return { asked, port };
};

describe('the month so far', () => {
  it('is the ledger against the plan, with the projection at the rate so far', async () => {
    const { asked, port } = portReading(month());

    expect(await port.usage(TENANT)).toEqual({
      period: '202610',
      resetsAt: '2026-11-01T00:00:00.000Z',
      plan: 'CANTINA',
      status: 'ACTIVE',
      used: 400,
      included: 1_500,
      purchased: 0,
      allowance: 1_500,
      state: 'ok',
      projected: 1_240,
      byDay: [],
      byOrigin: [],
    });
    expect(asked).toEqual([[TENANT, '202610']]);
  });

  it('counts what was bought into the allowance, as the gate does', async () => {
    const { port } = portReading(month({ used: 1_500, purchased: 1_000 }));

    expect(await port.usage(TENANT)).toMatchObject({
      included: 1_500,
      purchased: 1_000,
      allowance: 2_500,
      state: 'ok',
    });
  });

  it.each<[number, 'ok' | 'near' | 'exceeded']>([
    [1_199, 'ok'],
    [1_200, 'near'],
    [1_499, 'near'],
    [1_500, 'exceeded'],
  ])('says %i of a Cantina month is %s, as the widget is told', async (used, state) => {
    const { port } = portReading(month({ used }));

    expect((await port.usage(TENANT)).state).toBe(state);
  });

  it('gives a winery with no plan the trial’s messages', async () => {
    const { port } = portReading(
      month({
        state: {
          status: 'TRIALING',
          plan: null,
          stripeCustomerId: null,
          stripeSubscriptionId: null,
          locale: 'it',
        },
      }),
    );

    expect(await port.usage(TENANT)).toMatchObject({ plan: null, included: 150 });
  });

  it('names the days and the origins, and a message with no conversation as no origin', async () => {
    const { port } = portReading(
      month({
        breakdown: {
          byDay: [{ key: '2026-10-01', messages: 3 }],
          byOrigin: [
            { key: 'https://www.cantina.example', messages: 2 },
            { key: '', messages: 1 },
          ],
        },
      }),
    );

    expect(await port.usage(TENANT)).toMatchObject({
      byDay: [{ day: '2026-10-01', messages: 3 }],
      byOrigin: [
        { origin: 'https://www.cantina.example', messages: 2 },
        { origin: null, messages: 1 },
      ],
    });
  });

  it('is a 404 for a winery that is gone', async () => {
    const { port } = portReading(undefined);

    await expect(port.usage(TENANT)).rejects.toThrow(NotFoundError);
  });
});

describe('the route', () => {
  const get = (role: 'OWNER' | 'EDITOR') => {
    const asked: string[] = [];
    const billing: BillingPort = {
      checkout: () => Promise.reject(new Error('not this route')),
      changePlan: () => Promise.reject(new Error('not this route')),
      portal: () => Promise.reject(new Error('not this route')),
      topUp: () => Promise.reject(new Error('not this route')),
      usage: async (tenantId) => {
        asked.push(tenantId);
        return portReading(month()).port.usage(tenantId);
      },
    };
    const response = createApp({
      auth: signedIn(),
      readMemberships: oneMembership(TENANT, role),
      billing,
    }).request('/v1/dashboard/usage');

    return { asked, response };
  };

  it.each(['OWNER', 'EDITOR'] as const)(
    'answers %s too: an editor is told when the month runs low',
    async (role) => {
      const { asked, response } = get(role);

      expect((await response).status).toBe(200);
      expect(asked).toEqual([TENANT]);
    },
  );
});
