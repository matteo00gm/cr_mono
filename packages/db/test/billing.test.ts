import { PgDialect } from 'drizzle-orm/pg-core';
import { describe, expect, it, vi } from 'vitest';

import {
  readBillingSnapshot,
  readBillingState,
  startTrial,
  writeBillingChange,
  type BillingChangeRow,
} from '../src/billing.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The billing statements, without a database (P5-02, P5-05). What the rows
 * actually become, under RLS and the 0061 CHECK, is
 * `billing.integration.test.ts`'s.
 */

/**
 * A transaction that records its statements and answers them in order. A
 * savepoint runs its callback on the same recorder, or fails the way the
 * caller says it does.
 */
const capturing = (responses: unknown[][] = [], failure?: Error) => {
  const statements: unknown[] = [];
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    return Promise.resolve(responses.shift() ?? []);
  });
  const transaction = vi.fn(async (fn: (inner: DbTransaction) => Promise<unknown>) => {
    if (failure !== undefined) throw failure;

    return fn({ execute } as unknown as DbTransaction);
  });

  return { statements, transaction, tx: { execute, transaction } as unknown as DbTransaction };
};

const params = (statement: unknown): unknown[] =>
  new PgDialect().sqlToQuery(statement as Parameters<PgDialect['sqlToQuery']>[0]).params;

const change: BillingChangeRow = {
  status: 'ACTIVE',
  plan: 'CANTINA',
  customerId: 'cus_1',
  subscriptionId: 'sub_1',
  lastEventAt: new Date('2026-09-30T12:00:20.000Z'),
};

describe('reading the state', () => {
  it('maps the row, and reads nothing where there is none', async () => {
    const row = {
      status: 'TRIALING',
      plan: null,
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: null,
      locale: 'it',
    };

    await expect(readBillingState(capturing([[row]]).tx)).resolves.toEqual({
      status: 'TRIALING',
      plan: null,
      stripeCustomerId: 'cus_1',
      stripeSubscriptionId: null,
      locale: 'it',
    });
    await expect(readBillingState(capturing().tx)).resolves.toBeUndefined();
  });
});

describe('the snapshot the machine reads', () => {
  it('locks the row for the rest of the transaction', async () => {
    const { tx, statements } = capturing();

    await readBillingSnapshot(tx);

    expect(text(statements[0])).toMatch(/FOR UPDATE/u);
  });

  it('reads the ordering clock as a date, from either form the driver gives it', async () => {
    const base = {
      status: 'ACTIVE',
      plan: 'CANTINA',
      stripe_customer_id: 'cus_1',
      stripe_subscription_id: 'sub_1',
    };
    const at = new Date('2026-09-30T12:00:20.000Z');

    await expect(
      readBillingSnapshot(capturing([[{ ...base, billing_event_at: at.toISOString() }]]).tx),
    ).resolves.toMatchObject({ lastEventAt: at });
    await expect(
      readBillingSnapshot(capturing([[{ ...base, billing_event_at: at }]]).tx),
    ).resolves.toMatchObject({ lastEventAt: at });
  });

  it('reads no clock before the first event, and nothing where there is no row', async () => {
    const row = {
      status: 'TRIALING',
      plan: null,
      stripe_customer_id: null,
      stripe_subscription_id: null,
      billing_event_at: null,
    };

    await expect(readBillingSnapshot(capturing([[row]]).tx)).resolves.toEqual({
      status: 'TRIALING',
      plan: null,
      customerId: null,
      subscriptionId: null,
      lastEventAt: null,
    });
    await expect(readBillingSnapshot(capturing().tx)).resolves.toBeUndefined();
  });
});

describe('writing the machine’s answer', () => {
  it('writes every field in one statement, in a savepoint', async () => {
    const { tx, statements, transaction } = capturing();

    await expect(writeBillingChange(tx, change)).resolves.toBe('written');
    expect(transaction).toHaveBeenCalledTimes(1);
    expect(statements).toHaveLength(1);
    expect(params(statements[0])).toEqual([
      'ACTIVE',
      'CANTINA',
      'cus_1',
      'sub_1',
      '2026-09-30T12:00:20.000Z',
    ]);
  });

  /** An error shaped as the driver throws it, or as Drizzle wraps it. */
  const failed = (fields: { code?: string; cause?: { code: string } }) =>
    Object.assign(new Error('Failed query'), fields);

  it.each([
    ['the driver’s own error', failed({ code: '23505' })],
    ['the error Drizzle wraps around it', failed({ cause: { code: '23505' } })],
  ])('reports a customer bound elsewhere, from %s', async (_what, failure) => {
    const { tx } = capturing([], failure);

    await expect(writeBillingChange(tx, change)).resolves.toBe('customer_taken');
  });

  it.each([
    ['a CHECK violation', failed({ cause: { code: '23514' } })],
    ['a connection that dropped', new Error('connection terminated')],
  ])('throws anything else, %s, rather than calling it handled', async (_what, failure) => {
    const { tx } = capturing([], failure);

    await expect(writeBillingChange(tx, change)).rejects.toBe(failure);
  });
});

describe('starting the trial', () => {
  it('moves only a winery waiting for its first domain, for the days it is handed', async () => {
    const endsAt = new Date('2026-10-14T12:00:00.000Z');
    const { tx, statements } = capturing([[{ trial_ends_at: endsAt.toISOString() }]]);

    await expect(startTrial(tx, 14)).resolves.toEqual(endsAt);
    expect(text(statements[0])).toContain("WHERE status = 'PENDING_VERIFICATION'");
    expect(params(statements[0])).toEqual([14]);
  });

  it('answers nothing when it started none', async () => {
    await expect(startTrial(capturing().tx, 14)).resolves.toBeUndefined();
  });
});
