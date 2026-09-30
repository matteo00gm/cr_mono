import { describe, expect, it } from 'vitest';

import {
  SERVED_STATUSES,
  TENANT_STATUSES,
  transition,
  type BillingEvent,
  type BillingSnapshot,
  type TenantStatus,
} from '../../src/billing/state.js';

/**
 * The subscription state machine (P5-05).
 *
 * Every transition the table names, every guard, and — because the database
 * CHECK added with it (§5.2b) would otherwise be the first to find out — a
 * sweep over every status and every event proving the machine never answers
 * with a state that CHECK forbids. P5-06 drives the same table end to end
 * through the signed endpoint.
 */

const CUSTOMER = 'cus_mine';
const SUBSCRIPTION = 'sub_mine';

const at = (second: number) => new Date(Date.UTC(2026, 8, 30, 12, 0, second));

const bound = (
  status: TenantStatus,
  overrides: Partial<BillingSnapshot> = {},
): BillingSnapshot => ({
  status,
  plan: 'CANTINA',
  customerId: CUSTOMER,
  subscriptionId: SUBSCRIPTION,
  lastEventAt: at(10),
  ...overrides,
});

const fresh = (status: TenantStatus = 'TRIALING'): BillingSnapshot => ({
  status,
  plan: null,
  customerId: null,
  subscriptionId: null,
  lastEventAt: null,
});

const base = { occurredAt: at(20), customerId: CUSTOMER, subscriptionId: SUBSCRIPTION };

const checkout = (
  overrides: Partial<Extract<BillingEvent, { kind: 'checkout_completed' }>> = {},
): BillingEvent => ({
  kind: 'checkout_completed',
  ...base,
  plan: 'ECOMMERCE',
  paid: true,
  ...overrides,
});

/**
 * `null` for a price that is not ours. Not `undefined`: a default parameter
 * swallows an explicit `undefined`, and the case meant to send a foreign price
 * would quietly send Cantina's.
 */
const changed = (
  stripeStatus: string,
  plan: 'CANTINA' | 'ECOMMERCE' | null = 'CANTINA',
): BillingEvent => ({
  kind: 'subscription_changed',
  ...base,
  stripeStatus,
  plan: plan ?? undefined,
});

const ended: BillingEvent = { kind: 'subscription_ended', ...base };
const failed: BillingEvent = { kind: 'payment_failed', ...base };
const succeeded: BillingEvent = { kind: 'payment_succeeded', ...base };

const statusAfter = (current: BillingSnapshot, event: BillingEvent) => {
  const result = transition(current, event);

  return result.outcome === 'apply' ? result.change.status : `ignored:${result.reason}`;
};

describe('a completed Checkout', () => {
  it('binds the customer and the subscription, sets the plan, and serves the winery once paid', () => {
    expect(transition(fresh('TRIALING'), checkout())).toEqual({
      outcome: 'apply',
      change: {
        status: 'ACTIVE',
        plan: 'ECOMMERCE',
        customerId: CUSTOMER,
        subscriptionId: SUBSCRIPTION,
        lastEventAt: at(20),
      },
    });
  });

  it('activates a winery that bought before its trial ever started', () => {
    expect(statusAfter(fresh('PENDING_VERIFICATION'), checkout())).toBe('ACTIVE');
  });

  it('binds but waits, when the payment settles later', () => {
    const result = transition(fresh('TRIALING'), checkout({ paid: false }));

    expect(result).toMatchObject({
      outcome: 'apply',
      change: { status: 'TRIALING', customerId: CUSTOMER, subscriptionId: SUBSCRIPTION },
    });
  });

  it('reactivates a returning customer whose last subscription ended', () => {
    const lapsed = bound('DISABLED', { subscriptionId: null, plan: null });

    expect(statusAfter(lapsed, checkout())).toBe('ACTIVE');
  });

  it('is applied again when redelivered for the same subscription', () => {
    expect(statusAfter(bound('ACTIVE', { lastEventAt: at(20) }), checkout())).toBe('ACTIVE');
  });

  it('does not replace a live subscription with a second one — two tabs, both paid', () => {
    expect(statusAfter(bound('ACTIVE'), checkout({ subscriptionId: 'sub_second' }))).toBe(
      'ignored:second_subscription',
    );
  });

  it('is refused for a plan that is not ours', () => {
    expect(statusAfter(fresh(), checkout({ plan: undefined }))).toBe('ignored:unknown_plan');
  });
});

describe('the guards before any transition', () => {
  it('ignore an event created before the last one applied', () => {
    expect(statusAfter(bound('ACTIVE', { lastEventAt: at(30) }), failed)).toBe('ignored:stale');
  });

  it('apply an event created in the same second as the last one', () => {
    expect(statusAfter(bound('ACTIVE', { lastEventAt: at(20) }), failed)).toBe('PAST_DUE');
  });

  it('ignore every event for a customer that is not this winery’s', () => {
    for (const event of [checkout(), changed('active'), ended, failed, succeeded]) {
      expect(statusAfter(bound('ACTIVE'), { ...event, customerId: 'cus_theirs' })).toBe(
        'ignored:customer_mismatch',
      );
    }
  });

  it('let only a Checkout bind a customer', () => {
    for (const event of [changed('active'), ended, failed, succeeded]) {
      expect(statusAfter(fresh(), event)).toBe('ignored:not_bound');
    }
  });

  it('ignore an event for a subscription that is not the winery’s current one', () => {
    for (const event of [changed('active'), ended, failed, succeeded]) {
      expect(statusAfter(bound('ACTIVE'), { ...event, subscriptionId: 'sub_old' })).toBe(
        'ignored:other_subscription',
      );
    }
  });

  it('reopen nothing for a winery that closed its account', () => {
    for (const event of [checkout(), changed('active'), ended, failed, succeeded]) {
      expect(statusAfter(bound('CANCELED'), event)).toBe('ignored:closed');
    }
  });
});

describe('a subscription that changed', () => {
  it.each([
    ['active', 'ACTIVE'],
    ['trialing', 'ACTIVE'],
    ['past_due', 'PAST_DUE'],
    ['unpaid', 'PAST_DUE'],
    ['paused', 'DISABLED'],
    ['canceled', 'DISABLED'],
    ['incomplete_expired', 'DISABLED'],
  ])('moves a winery to what Stripe’s %s means', (stripeStatus, expected) => {
    expect(statusAfter(bound('ACTIVE'), changed(stripeStatus))).toBe(expected);
  });

  it('keeps the status while a first payment is incomplete', () => {
    expect(statusAfter(bound('TRIALING'), changed('incomplete'))).toBe('TRIALING');
  });

  it('clears the subscription when Stripe says it is over, so the winery can buy again', () => {
    expect(transition(bound('ACTIVE'), changed('canceled'))).toMatchObject({
      change: { status: 'DISABLED', subscriptionId: null, plan: null, customerId: CUSTOMER },
    });
  });

  it('takes the new plan from the price, which is how an upgrade lands (P5-09)', () => {
    expect(transition(bound('ACTIVE'), changed('active', 'ECOMMERCE'))).toMatchObject({
      change: { status: 'ACTIVE', plan: 'ECOMMERCE' },
    });
  });

  it('keeps the plan on file for a price that is not ours, rather than guessing', () => {
    expect(transition(bound('ACTIVE'), changed('active', null))).toMatchObject({
      change: { plan: 'CANTINA' },
    });
  });

  it('ignores a status it has no transition for', () => {
    expect(statusAfter(bound('ACTIVE'), changed('frobnicated'))).toBe(
      'ignored:unrecognised_status',
    );
  });
});

describe('a subscription that ended', () => {
  it('switches the widget off and clears the subscription, keeping the customer', () => {
    expect(transition(bound('ACTIVE'), ended)).toEqual({
      outcome: 'apply',
      change: {
        status: 'DISABLED',
        plan: null,
        customerId: CUSTOMER,
        subscriptionId: null,
        lastEventAt: at(20),
      },
    });
  });
});

describe('a payment', () => {
  it('that failed blocks the widget at once — no grace (§5.2b)', () => {
    expect(statusAfter(bound('ACTIVE'), failed)).toBe('PAST_DUE');
  });

  it('that failed again changes nothing further, but moves the clock', () => {
    expect(transition(bound('PAST_DUE'), failed)).toMatchObject({
      change: { status: 'PAST_DUE', lastEventAt: at(20) },
    });
  });

  it('that failed does not cut a trial short', () => {
    expect(statusAfter(bound('TRIALING'), failed)).toBe('TRIALING');
  });

  it('that succeeded restores service with no human (§5.2b)', () => {
    expect(statusAfter(bound('PAST_DUE'), succeeded)).toBe('ACTIVE');
  });

  it('that succeeded late, after a later failure, is ignored rather than un-blocking', () => {
    const blocked = bound('PAST_DUE', { lastEventAt: at(30) });

    expect(statusAfter(blocked, succeeded)).toBe('ignored:stale');
  });

  it('that failed late, after a later success, is ignored rather than darkening a payer', () => {
    const paying = bound('ACTIVE', { lastEventAt: at(30) });

    expect(statusAfter(paying, failed)).toBe('ignored:stale');
  });
});

describe('every answer the machine can give', () => {
  const events: BillingEvent[] = [
    checkout(),
    checkout({ paid: false }),
    ...['active', 'trialing', 'past_due', 'unpaid', 'paused', 'canceled', 'incomplete'].map((s) =>
      changed(s),
    ),
    ended,
    failed,
    succeeded,
  ];

  const snapshots = TENANT_STATUSES.flatMap((status) => [fresh(status), bound(status)]);

  it('never serves ACTIVE without a subscription on file (§5.2b’s CHECK)', () => {
    for (const current of snapshots) {
      for (const event of events) {
        const result = transition(current, event);

        if (result.outcome === 'apply' && result.change.status === 'ACTIVE') {
          expect(result.change.subscriptionId, `${current.status} + ${event.kind}`).not.toBeNull();
        }
      }
    }
  });

  it('never moves a winery into TRIALING, whose end date only the trial’s start sets', () => {
    for (const current of snapshots) {
      for (const event of events) {
        const result = transition(current, event);

        if (result.outcome === 'apply' && result.change.status === 'TRIALING') {
          expect(current.status, event.kind).toBe('TRIALING');
        }
      }
    }
  });

  it('stamps every write with the event’s own time', () => {
    for (const current of snapshots) {
      for (const event of events) {
        const result = transition(current, event);

        if (result.outcome === 'apply') expect(result.change.lastEventAt).toEqual(event.occurredAt);
      }
    }
  });
});

describe('the statuses a widget is served in', () => {
  it('are ACTIVE and TRIALING, and PAST_DUE is not one of them', () => {
    expect([...SERVED_STATUSES].sort()).toEqual(['ACTIVE', 'TRIALING']);
  });
});
