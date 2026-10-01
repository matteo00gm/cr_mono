import { describe, expect, it, vi } from 'vitest';

import {
  claimQuotaNotice,
  countPurchased,
  countUsage,
  readUsageBreakdown,
  recordPaidCharge,
  recordTopUp,
  recordUsage,
  rollupUsageDay,
} from '../src/usage.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The statements the ledger issues (P2-31).
 *
 * **These predicates are belt and braces, and that is exactly why they need a
 * unit test.** RLS scopes both tables, so a statement that dropped its tenant
 * predicate would still behave correctly against a real database — every
 * integration case would pass, and the redundancy that protects the day a
 * policy changes would be gone with nothing to show for it. Only the statement
 * text can say whether it is still there.
 */

const capturing = (...responses: unknown[][]) => {
  const statements: unknown[] = [];
  let call = 0;
  const execute = vi.fn((statement: unknown): Promise<unknown[]> => {
    statements.push(statement);
    const rows = responses[call] ?? [];
    call += 1;

    return Promise.resolve(rows);
  });

  return { statements, tx: { execute } as unknown as DbTransaction };
};

const USAGE = {
  period: '202609',
  kind: 'chat_message',
  sessionId: 'sess-1',
  inputTokens: 1000,
  outputTokens: 500,
  costMicros: 180,
};

describe('writing a bill', () => {
  it('takes the tenant from the setting, never from the caller', async () => {
    // P0-48: a tenant is never an argument, here or anywhere. `recordUsage` has
    // no parameter for one, and the statement reads whatever `withTenant` set.
    const { statements, tx } = capturing();

    await recordUsage(tx, USAGE);

    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
  });

  it('inserts and never updates, because the ledger is append-only', async () => {
    // P0-31 revokes UPDATE and DELETE from `app_rw`, so an upsert here would
    // fail at the grant — which is the point: a correction is another row.
    const { statements, tx } = capturing();

    await recordUsage(tx, USAGE);

    expect(statements).toHaveLength(1);
    expect(text(statements[0])).toContain('insert into usage_events');
    expect(text(statements[0])).not.toContain('on conflict');
  });
});

describe('counting a period', () => {
  it('is scoped by tenant, period and kind', async () => {
    const { statements, tx } = capturing([{ used: 3 }]);

    await countUsage(tx, '202609', 'chat_message');

    const statement = text(statements[0]);

    expect(statement).toContain("current_setting('app.tenant_id'");
    expect(statement).toContain('and period =');
    expect(statement).toContain('and kind =');
  });

  it('counts rows rather than summing tokens', async () => {
    // The tenant-facing limit is messages, because that is the unit a seller
    // understands and the unit the plan advertises. A cap in tokens is a cap
    // nobody can predict from their own behaviour.
    const { statements, tx } = capturing([{ used: 3 }]);

    await countUsage(tx, '202609', 'chat_message');

    expect(text(statements[0])).toContain('count(*)');
    expect(text(statements[0])).not.toContain('sum(');
  });

  it('is an equality on the period, which is what the YYYYMM shape is for', async () => {
    // Not a range over `created_at`: this runs before every model call, and the
    // index is on `(tenant_id, period)`.
    const { statements, tx } = capturing([{ used: 0 }]);

    await countUsage(tx, '202609', 'chat_message');

    expect(text(statements[0])).not.toContain('created_at');
  });

  it('refuses a count it could not read rather than reporting none', async () => {
    /*
     * Unreachable — `count(*)` always returns a row — and it throws anyway,
     * because the default that suggests itself is nought and nought is the
     * answer that grants unlimited usage. A cost gate whose read failed must
     * not be a cost gate that let everything through.
     */
    const { tx } = capturing([]);

    await expect(countUsage(tx, '202609', 'chat_message')).rejects.toThrow(/no row/);
  });
});

/*
 * The P5 ledgers' statements. Their behaviour against Postgres is the
 * integration suites'; what only the text can say is that each one takes the
 * tenant from the setting, and how each reads its own answer back.
 */

describe('the top-up ledger (P5-11a)', () => {
  const TOP_UP = { period: '202610', messages: 1000, paymentIntentId: 'pi_1' };

  it('credits under the setting’s tenant, once per payment', async () => {
    const { statements, tx } = capturing([{ id: 'x' }]);

    expect(await recordTopUp(tx, TOP_UP)).toBe('credited');
    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
    expect(text(statements[0])).toContain('on conflict (stripe_payment_intent_id) do nothing');
  });

  it('reads a payment already credited as a duplicate', async () => {
    const { tx } = capturing([]);

    expect(await recordTopUp(tx, TOP_UP)).toBe('duplicate');
  });

  it('sums the period, and reads nought where nothing was bought', async () => {
    expect(await countPurchased(capturing([{ purchased: 2000 }]).tx, '202610')).toBe(2000);
    expect(await countPurchased(capturing([]).tx, '202610')).toBe(0);
  });
});

describe('the quota notices (P5-12)', () => {
  it('is the claimer’s when the row is new, and nobody else’s', async () => {
    const claimed = capturing([{ threshold: 80 }]);

    expect(await claimQuotaNotice(claimed.tx, '202610', 80)).toBe(true);
    expect(text(claimed.statements[0])).toContain("current_setting('app.tenant_id'");
    expect(await claimQuotaNotice(capturing([]).tx, '202610', 80)).toBe(false);
  });

  it('breaks the month down by day and by origin, as strings and numbers', async () => {
    const { tx } = capturing(
      [{ key: '2026-10-01', messages: '3' }],
      [{ key: 'https://www.cantina.example', messages: 3 }],
    );

    expect(await readUsageBreakdown(tx, '202610', 'chat_message')).toEqual({
      byDay: [{ key: '2026-10-01', messages: 3 }],
      byOrigin: [{ key: 'https://www.cantina.example', messages: 3 }],
    });
  });
});

describe('the charges an e-invoice may be owed for (P5-03a)', () => {
  const CHARGE = {
    stripeObjectId: 'in_1',
    source: 'invoice' as const,
    amountCents: 2900,
    currency: 'eur',
    paidAt: new Date('2026-10-01T10:00:00Z'),
  };

  it('records under the setting’s tenant, once per Stripe object', async () => {
    const { statements, tx } = capturing([{ id: 'x' }]);

    expect(await recordPaidCharge(tx, CHARGE)).toBe('recorded');
    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
    expect(text(statements[0])).toContain('on conflict (stripe_object_id) do nothing');
  });

  it('reads a charge already recorded as a duplicate', async () => {
    expect(await recordPaidCharge(capturing([]).tx, CHARGE)).toBe('duplicate');
  });
});

describe('a day, rolled up (P5-13)', () => {
  it('replaces the day under the setting’s tenant, and reads back what it wrote', async () => {
    const { statements, tx } = capturing([
      {
        messages: 3,
        conversations: 1,
        add_to_carts: 2,
        tokens_in: '3500',
        tokens_out: '850',
        cost_micros: '404',
      },
    ]);

    expect(await rollupUsageDay(tx, '2026-10-14')).toEqual({
      messages: 3,
      conversations: 1,
      addToCarts: 2,
      tokensIn: 3500,
      tokensOut: 850,
      costMicros: 404,
    });
    expect(text(statements[0])).toContain("current_setting('app.tenant_id'");
    expect(text(statements[0])).toContain('ON CONFLICT (tenant_id, day) DO UPDATE');
  });

  it('refuses a statement that returned nothing rather than reporting a quiet day', async () => {
    await expect(rollupUsageDay(capturing([]).tx, '2026-10-14')).rejects.toThrow(/no row/u);
  });
});
