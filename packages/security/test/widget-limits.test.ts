import { describe, expect, it } from 'vitest';

import {
  isPlanCap,
  tenantOfPlanCap,
  planCapCheck,
  QUOTA_NEAR_SHARE,
  quotaStateOf,
  unresolvedLimitCheck,
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
      { key: `tenant:${TENANT}:min`, limit: 60, windowSec: 60 },
      { key: `endpoint:config:${TENANT}`, limit: 120, windowSec: 60 },
    ]);
  });

  it('adds the session to a session mint that continues one, and still no month', () => {
    expect(widgetLimitChecks(request({ endpoint: 'session', sessionId: 'sid-1' }))).toEqual([
      { key: 'session:sid-1:session', limit: 6, windowSec: 60 },
      { key: `ip:bucket:${TENANT}:session`, limit: 10, windowSec: 60 },
      { key: `tenant:${TENANT}:min`, limit: 60, windowSec: 60 },
      { key: `endpoint:session:${TENANT}`, limit: 60, windowSec: 60 },
    ]);
  });

  it('draws chat from all five, with the month as a calendar window', () => {
    expect(widgetLimitChecks(request({ endpoint: 'chat', sessionId: 'sid-1' }))).toEqual([
      { key: 'session:sid-1:chat', limit: 6, windowSec: 60 },
      { key: `ip:bucket:${TENANT}:chat`, limit: 20, windowSec: 60 },
      { key: `tenant:${TENANT}:min`, limit: 60, windowSec: 60 },
      { key: `endpoint:chat:${TENANT}`, limit: 60, windowSec: 60 },
      { key: `tenant:${TENANT}:month`, limit: 1_500, window: 'month' },
    ]);
  });

  it('leaves the session out when there is none yet', () => {
    const keys = widgetLimitChecks(request({ endpoint: 'chat' })).map((check) => check.key);

    expect(keys.some((key) => key.startsWith('session:'))).toBe(false);
    expect(keys).toHaveLength(4);
  });

  it('counts a tenant with no subscription at the no-subscription tier', () => {
    const checks = widgetLimitChecks(request({ endpoint: 'chat', plan: null }));

    expect(checks.find((check) => check.key === `tenant:${TENANT}:min`)?.limit).toBe(30);
    expect(checks.find((check) => check.key === `tenant:${TENANT}:month`)?.limit).toBe(150);
  });

  it('counts a tenant at the tier it pays for', () => {
    const checks = widgetLimitChecks(request({ endpoint: 'chat', plan: 'ECOMMERCE' }));

    expect(checks.find((check) => check.key === `tenant:${TENANT}:min`)?.limit).toBe(120);
    expect(checks.find((check) => check.key === `tenant:${TENANT}:month`)?.limit).toBe(6_000);
  });

  it('takes its numbers from the table it is handed', () => {
    const tiny: WidgetLimits = {
      unresolvedPerMinute: 15,
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

  it('lets one address use every endpoint of a winery before the address-wide limit binds', () => {
    // A real visitor hits a winery's own limits first; the unresolved limit is for scripts.
    const { config, session, chat } = WIDGET_LIMITS.ipPerMinute;

    expect(WIDGET_LIMITS.unresolvedPerMinute).toBeGreaterThan(config + session + chat);
  });

  it('gives a session less chat than its address, so visitors sharing one each get a turn', () => {
    expect(WIDGET_LIMITS.sessionPerMinute.chat).toBeLessThan(WIDGET_LIMITS.ipPerMinute.chat);
  });

  it('caps a month at the allowances the plans are sold with, and a trial at its hard cap', () => {
    // P5-01's 1,500 and 6,000 messages, and the 150-message trial (Open Decisions).
    expect(WIDGET_LIMITS.messagesPerMonth).toEqual({ CANTINA: 1_500, ECOMMERCE: 6_000, none: 150 });
  });

  it('keeps one winery’s chat to at most half of the API’s ten concurrent executions', () => {
    // Replies take three to eight seconds; five is the planning figure (§5.1).
    const concurrentAtFiveSeconds = (WIDGET_LIMITS.endpointPerMinute.chat * 5) / 60;

    expect(concurrentAtFiveSeconds).toBeLessThanOrEqual(10 / 2);
  });
});

describe('unresolvedLimitCheck (review fix)', () => {
  it('is the address alone, per minute, before any tenant is known', () => {
    expect(unresolvedLimitCheck('bucket')).toEqual({
      key: 'ip:bucket:unresolved',
      limit: 120,
      windowSec: 60,
    });
  });

  it('takes its number from the table it is handed', () => {
    const limits = { ...WIDGET_LIMITS, unresolvedPerMinute: 3 };

    expect(unresolvedLimitCheck('bucket', limits).limit).toBe(3);
  });

  it('never shares a bucket with an address counted against a tenant', () => {
    const tenantKeys = (['config', 'session', 'chat'] as const).flatMap((endpoint) =>
      widgetLimitChecks(request({ endpoint, sessionId: 's' })).map((check) => check.key),
    );

    expect(tenantKeys).not.toContain(unresolvedLimitCheck('bucket').key);
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

describe('tenantOfPlanCap (P2-36)', () => {
  it('reads the tenant out of the key planCapCheck built', () => {
    expect(tenantOfPlanCap(planCapCheck(TENANT, 'CANTINA').key)).toBe(TENANT);
  });

  it.each([
    [`tenant:${TENANT}:min`],
    ['session:sid-1:month'],
    ['ip:bucket:unresolved'],
    [`endpoint:chat:${TENANT}`],
  ])('has no tenant to read out of %s', (key) => {
    /*
     * The guard is the point. Slicing without it turns `ip:bucket:unresolved`
     * into `bucket:unreso` — a string shaped like nothing, handed to a scope
     * that expects a tenant id. Undefined is the only honest answer.
     */
    expect(tenantOfPlanCap(key)).toBeUndefined();
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
      limit: 150,
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
