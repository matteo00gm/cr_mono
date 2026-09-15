import { describe, expect, it } from 'vitest';

import {
  isPlanCap,
  planCapCheck,
  QUOTA_NEAR_SHARE,
  quotaStateOf,
  WIDGET_LIMITS,
  widgetLimitChecks,
  type WidgetLimits,
  type WidgetRequest,
} from '../src/rate-limit/index.js';

/**
 * The widget's limit dimensions (P2-04, §3.6).
 *
 * Which buckets each endpoint draws from, which tier a tenant is counted at,
 * and that the plan cap is recognisable. The address HMAC is `apps/api`'s, and
 * is tested there.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';

const request = (overrides: Partial<WidgetRequest> = {}): WidgetRequest => ({
  endpoint: 'config',
  tenantId: TENANT,
  plan: 'CANTINA',
  ipBucket: 'bucket',
  ...overrides,
});

describe('widgetLimitChecks', () => {
  it('draws config from the address, the tenant minute and the endpoint, never the month', () => {
    // A session id on config is ignored: config is fetched before any session exists.
    expect(widgetLimitChecks(request({ sessionId: 'sid-1' }))).toEqual([
      { key: `ip:bucket:${TENANT}:config`, limit: 60, windowSec: 60 },
      { key: `tenant:${TENANT}:min`, limit: 120, windowSec: 60 },
      { key: `endpoint:config:${TENANT}`, limit: 600, windowSec: 60 },
    ]);
  });

  it('adds the session to a session mint that continues one, and still no month', () => {
    expect(widgetLimitChecks(request({ endpoint: 'session', sessionId: 'sid-1' }))).toEqual([
      { key: 'session:sid-1:session', limit: 6, windowSec: 60 },
      { key: `ip:bucket:${TENANT}:session`, limit: 12, windowSec: 60 },
      { key: `tenant:${TENANT}:min`, limit: 120, windowSec: 60 },
      { key: `endpoint:session:${TENANT}`, limit: 120, windowSec: 60 },
    ]);
  });

  it('draws chat from all five, with the month as a calendar window', () => {
    expect(widgetLimitChecks(request({ endpoint: 'chat', sessionId: 'sid-1' }))).toEqual([
      { key: 'session:sid-1:chat', limit: 12, windowSec: 60 },
      { key: `ip:bucket:${TENANT}:chat`, limit: 30, windowSec: 60 },
      { key: `tenant:${TENANT}:min`, limit: 120, windowSec: 60 },
      { key: `endpoint:chat:${TENANT}`, limit: 120, windowSec: 60 },
      { key: `tenant:${TENANT}:month`, limit: 1_000, window: 'month' },
    ]);
  });

  it('leaves the session out when there is none yet', () => {
    const keys = widgetLimitChecks(request({ endpoint: 'chat' })).map((check) => check.key);

    expect(keys.some((key) => key.startsWith('session:'))).toBe(false);
    expect(keys).toHaveLength(4);
  });

  it('counts a tenant with no subscription at the no-subscription tier', () => {
    const checks = widgetLimitChecks(request({ endpoint: 'chat', plan: null }));

    expect(checks.find((check) => check.key === `tenant:${TENANT}:min`)?.limit).toBe(60);
    expect(checks.find((check) => check.key === `tenant:${TENANT}:month`)?.limit).toBe(100);
  });

  it('counts a tenant at the tier it pays for', () => {
    const checks = widgetLimitChecks(request({ endpoint: 'chat', plan: 'ECOMMERCE' }));

    expect(checks.find((check) => check.key === `tenant:${TENANT}:min`)?.limit).toBe(600);
    expect(checks.find((check) => check.key === `tenant:${TENANT}:month`)?.limit).toBe(10_000);
  });

  it('takes its numbers from the table it is handed', () => {
    const tiny: WidgetLimits = {
      sessionPerMinute: { session: 1, chat: 2 },
      ipPerMinute: { config: 3, session: 4, chat: 5 },
      tenantPerMinute: { CANTINA: 6, ECOMMERCE: 7, none: 8 },
      endpointPerMinute: { config: 9, session: 10, chat: 11 },
      messagesPerMonth: { CANTINA: 12, ECOMMERCE: 13, none: 14 },
    };

    expect(
      widgetLimitChecks(request({ endpoint: 'chat', sessionId: 's' }), tiny).map((c) => c.limit),
    ).toEqual([2, 5, 6, 11, 12]);
  });
});

describe('WIDGET_LIMITS', () => {
  it('gives config the most room and a session mint the least, per address', () => {
    const { config, session, chat } = WIDGET_LIMITS.ipPerMinute;

    expect(config).toBeGreaterThan(chat);
    expect(chat).toBeGreaterThan(session);
  });

  it('ranks a paying tier above a tenant with no subscription', () => {
    for (const table of [WIDGET_LIMITS.tenantPerMinute, WIDGET_LIMITS.messagesPerMonth]) {
      expect(table.ECOMMERCE).toBeGreaterThan(table.CANTINA);
      expect(table.CANTINA).toBeGreaterThan(table.none);
    }
  });
});

describe('isPlanCap', () => {
  it.each([
    [`tenant:${TENANT}:month`, true],
    [`tenant:${TENANT}:min`, false],
    ['session:sid-1:month', false],
    [`endpoint:chat:${TENANT}`, false],
  ])('%s → %s', (key, expected) => {
    expect(isPlanCap(key)).toBe(expected);
  });
});

describe('planCapCheck (P2-10)', () => {
  it('is exactly the check chat spends, so reading the month and spending it cannot disagree', () => {
    const chat = widgetLimitChecks(request({ endpoint: 'chat', plan: 'ECOMMERCE' }));

    expect(chat.at(-1)).toEqual(planCapCheck(TENANT, 'ECOMMERCE'));
  });

  it('counts a tenant with no plan at the no-subscription tier', () => {
    expect(planCapCheck(TENANT, null)).toEqual({
      key: `tenant:${TENANT}:month`,
      limit: 100,
      window: 'month',
    });
  });

  it('is recognised as the plan cap, so its numbers stay out of headers', () => {
    expect(isPlanCap(planCapCheck(TENANT, 'CANTINA').key)).toBe(true);
  });
});

describe('quotaStateOf (P2-10)', () => {
  it.each<[number, number, 'ok' | 'near' | 'exceeded']>([
    [0, 1_000, 'ok'],
    [799, 1_000, 'ok'],
    [800, 1_000, 'near'],
    [999, 1_000, 'near'],
    [1_000, 1_000, 'exceeded'],
    [1_500, 1_000, 'exceeded'],
    [0, 0, 'exceeded'],
  ])('%i used of %i is %s', (used, limit, state) => {
    expect(quotaStateOf(used, limit)).toBe(state);
  });

  it('warns from four fifths of the cap', () => {
    expect(QUOTA_NEAR_SHARE).toBe(0.8);
  });
});
