import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { recordAttributions, type OrderToAttribute } from '../src/attributions.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * Recording what the sommelier sold, without a database (P6-07): what the one
 * statement says and binds. Whose visit a line may carry is real Postgres, in
 * `attributions.integration.test.ts`.
 */

const fakeTx = (...answers: unknown[][]) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() =>
    Promise.resolve(answers.shift() ?? []),
  );

  return { execute, tx: { execute } as unknown as DbTransaction };
};

/** The one statement a call issued. */
const issued = (fake: ReturnType<typeof fakeTx>): SQL => {
  const statement = fake.execute.mock.calls[0]?.[0];

  if (statement === undefined) throw new Error('No statement was issued.');

  return statement;
};

const bound = (fake: ReturnType<typeof fakeTx>): unknown[] =>
  new PgDialect().sqlToQuery(issued(fake)).params;

const said = (fake: ReturnType<typeof fakeTx>): string => text(issued(fake));

const ORDER: OrderToAttribute = {
  shop: 'cantina-rossi.myshopify.com',
  orderId: 'gid://shopify/Order/1',
  currency: 'EUR',
  orderedAt: new Date('2026-10-05T08:15:30.000Z'),
  lines: [
    {
      lineItemId: 'gid://shopify/LineItem/1',
      sessionId: 'visit-0001',
      variantId: '45123456789',
      quantity: 2,
      amountCents: 7400,
    },
    {
      lineItemId: 'gid://shopify/LineItem/2',
      sessionId: 'visit-0002',
      variantId: null,
      quantity: 1,
      amountCents: 1850,
    },
  ],
};

describe('recordAttributions', () => {
  it('asks the database nothing for an order with no lines of ours', async () => {
    const fake = fakeTx();

    expect(await recordAttributions(fake.tx, { ...ORDER, lines: [] })).toBe(0);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('sends the order’s lines as one parameter, in one statement', async () => {
    const fake = fakeTx([{ id: 'a-1' }, { id: 'a-2' }]);

    expect(await recordAttributions(fake.tx, ORDER)).toBe(2);
    expect(fake.execute).toHaveBeenCalledTimes(1);

    const [shop, orderId, currency, orderedAt, rows] = bound(fake);

    expect([shop, orderId, currency, orderedAt]).toEqual([
      'cantina-rossi.myshopify.com',
      'gid://shopify/Order/1',
      'EUR',
      '2026-10-05T08:15:30.000Z',
    ]);
    expect(JSON.parse(String(rows))).toEqual([
      {
        line_item_id: 'gid://shopify/LineItem/1',
        session_id: 'visit-0001',
        variant_id: '45123456789',
        quantity: 2,
        amount_cents: 7400,
      },
      {
        line_item_id: 'gid://shopify/LineItem/2',
        session_id: 'visit-0002',
        variant_id: null,
        quantity: 1,
        amount_cents: 1850,
      },
    ]);
  });

  it('counts what this delivery added, which for a redelivery is nothing', async () => {
    expect(await recordAttributions(fakeTx([]).tx, ORDER)).toBe(0);
    expect(await recordAttributions(fakeTx([{ id: 'a-1' }]).tx, ORDER)).toBe(1);
  });

  it('takes the winery from the scope, never from an argument', async () => {
    const fake = fakeTx([]);

    await recordAttributions(fake.tx, ORDER);

    expect(said(fake)).toContain("current_setting('app.tenant_id', true)");
    expect(bound(fake)).toHaveLength(5);
  });

  it('holds each line to a visit the winery had, and to its own key', async () => {
    const fake = fakeTx([]);

    await recordAttributions(fake.tx, ORDER);

    expect(said(fake)).toMatch(
      /WHERE EXISTS \(SELECT 1 FROM widget_events e WHERE e\.session_id = l\.session_id\)/u,
    );
    expect(said(fake)).toMatch(/ON CONFLICT \(tenant_id, order_id, line_item_id\) DO NOTHING/u);
  });

  it('leaves the moment to the database when Shopify did not give one', async () => {
    const fake = fakeTx([]);

    await recordAttributions(fake.tx, { ...ORDER, orderedAt: undefined });

    expect(bound(fake)[3]).toBeNull();
    expect(said(fake)).toContain('now()');
  });
});
