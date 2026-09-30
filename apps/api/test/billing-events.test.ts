import type { BillingChangeRow, BillingSnapshotRow, DbTransaction } from '@catalogorosso/db';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * The billing effect's decisions, without a database (P5-05). What reaches the
 * row, the ledger and the audit log is `billing-events.integration.test.ts`'s.
 */

const TENANT = '11111111-1111-4111-8111-111111111111';

const state = {
  snapshot: undefined as BillingSnapshotRow | undefined,
  written: [] as BillingChangeRow[],
  outcome: 'written' as 'written' | 'customer_taken',
  audits: [] as { action: string; metadata: string | undefined; actorUserId: string | undefined }[],
};

vi.mock('@catalogorosso/db', () => ({
  readBillingSnapshot: () => Promise.resolve(state.snapshot),
  writeBillingChange: (_tx: unknown, change: BillingChangeRow) => {
    state.written.push(change);
    return Promise.resolve(state.outcome);
  },
  insertAuditRow: (
    _tx: unknown,
    row: { action: string; metadata: string | undefined; actorUserId: string | undefined },
  ) => {
    state.audits.push(row);
    return Promise.resolve();
  },
}));

const { createBillingEffect } = await import('../src/billing-events.js');
const { logger } = await import('../src/middleware/logger.js');

const tx = {} as DbTransaction;

const paying: BillingSnapshotRow = {
  status: 'ACTIVE',
  plan: 'CANTINA',
  customerId: 'cus_1',
  subscriptionId: 'sub_1',
  lastEventAt: new Date(1_790_000_000_000),
};

const delivery = (
  type: string,
  object: Record<string, unknown>,
  livemode = false,
  created = 1_790_000_100,
) => ({
  eventId: 'evt_1',
  type,
  tenantId: TENANT,
  payload: { id: 'evt_1', type, created, livemode, data: { object } },
});

const failedInvoice = (customer = 'cus_1') =>
  delivery('invoice.payment_failed', {
    customer,
    parent: { subscription_details: { subscription: 'sub_1' } },
  });

const effect = createBillingEffect({ livemode: false });

beforeEach(() => {
  state.snapshot = paying;
  state.written = [];
  state.outcome = 'written';
  state.audits = [];
  vi.spyOn(logger, 'info').mockImplementation(() => undefined);
  vi.spyOn(logger, 'warn').mockImplementation(() => undefined);
  vi.spyOn(logger, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('an event the machine acts on', () => {
  it('writes the change and audits the move, with no actor', async () => {
    expect(await effect(tx, failedInvoice())).toBe(true);
    expect(state.written).toEqual([
      { ...paying, status: 'PAST_DUE', lastEventAt: new Date(1_790_000_100_000) },
    ]);
    expect(state.audits).toEqual([
      expect.objectContaining({
        action: 'billing.status_changed',
        actorUserId: undefined,
        metadata: JSON.stringify({
          from: 'ACTIVE',
          to: 'PAST_DUE',
          event: 'invoice.payment_failed',
        }),
      }),
    ]);
  });

  it('writes a change that moves only the clock, and audits nothing', async () => {
    state.snapshot = { ...paying, status: 'PAST_DUE' };

    expect(await effect(tx, failedInvoice())).toBe(true);
    expect(state.written).toHaveLength(1);
    expect(state.audits).toEqual([]);
  });
});

describe('an event that changes nothing', () => {
  it('when it is not a type the machine reads, and says nothing', async () => {
    expect(await effect(tx, delivery('customer.created', { id: 'cus_1' }))).toBe(false);
    expect(state.written).toEqual([]);
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('when it is a type the machine reads, in a shape it cannot, and says so', async () => {
    expect(await effect(tx, delivery('invoice.paid', { customer: { id: 'cus_1' } }))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_unreadable', type: 'invoice.paid' },
      expect.any(String),
    );
  });

  it('when it is from the other mode, loudly', async () => {
    const live = { ...failedInvoice(), payload: { ...failedInvoice().payload, livemode: true } };

    expect(await effect(tx, live)).toBe(false);
    expect(state.written).toEqual([]);
    expect(logger.error).toHaveBeenCalledWith(
      { kind: 'stripe_event_wrong_mode', type: 'invoice.payment_failed' },
      expect.stringContaining('live-mode'),
    );
  });

  it('when a production stage receives a test event, loudly the other way', async () => {
    expect(await createBillingEffect({ livemode: true })(tx, failedInvoice())).toBe(false);
    expect(logger.error).toHaveBeenCalledWith(
      { kind: 'stripe_event_wrong_mode', type: 'invoice.payment_failed' },
      expect.stringContaining('test-mode'),
    );
  });

  it('when the winery it names is gone', async () => {
    state.snapshot = undefined;

    expect(await effect(tx, failedInvoice())).toBe(false);
    expect(state.written).toEqual([]);
  });

  it('when it is out of order — said quietly, because Stripe does that', async () => {
    state.snapshot = { ...paying, lastEventAt: new Date(1_790_000_200_000) };

    expect(await effect(tx, failedInvoice())).toBe(false);
    expect(state.written).toEqual([]);
    expect(logger.info).toHaveBeenCalledWith(
      { kind: 'stripe_event_ignored', type: 'stale' },
      expect.any(String),
    );
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('when it is for another customer — said loudly, because somebody did that', async () => {
    expect(await effect(tx, failedInvoice('cus_stranger'))).toBe(false);
    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_ignored', type: 'customer_mismatch' },
      expect.any(String),
    );
  });

  it('when its customer is bound to another winery, and audits nothing', async () => {
    state.outcome = 'customer_taken';

    expect(await effect(tx, failedInvoice())).toBe(false);
    expect(state.audits).toEqual([]);
    expect(logger.warn).toHaveBeenCalledWith(
      { kind: 'stripe_event_ignored', type: 'customer_taken' },
      expect.any(String),
    );
  });
});
