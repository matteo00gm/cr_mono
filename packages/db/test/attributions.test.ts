import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import {
  countOrderEntries,
  eraseOrders,
  eraseShop,
  recordAttributions,
  recordRefunds,
  type OrderToAttribute,
  type RefundToRecord,
} from '../src/attributions.js';
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
    expect(said(fake)).toMatch(
      /ON CONFLICT \(tenant_id, order_id, line_item_id\) WHERE refund_line_id IS NULL DO NOTHING/u,
    );
  });

  it('leaves the moment to the database when Shopify did not give one', async () => {
    const fake = fakeTx([]);

    await recordAttributions(fake.tx, { ...ORDER, orderedAt: undefined });

    expect(bound(fake)[3]).toBeNull();
    expect(said(fake)).toContain('now()');
  });
});

describe('recordRefunds', () => {
  const REFUND: RefundToRecord = {
    orderIds: ['gid://shopify/Order/1', '1'],
    lines: [{ refundLineId: 'rl-1', lineItemIds: ['gid://shopify/LineItem/1', '1'], quantity: 1 }],
  };

  it('asks the database nothing for a refund that names no line, or no order', async () => {
    const fake = fakeTx();

    expect(await recordRefunds(fake.tx, { ...REFUND, lines: [] })).toBe(0);
    expect(await recordRefunds(fake.tx, { ...REFUND, orderIds: [] })).toBe(0);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('sends the refund’s lines and the order’s spellings, in one statement', async () => {
    const fake = fakeTx([{ id: 'r-1' }]);

    expect(await recordRefunds(fake.tx, REFUND)).toBe(1);
    expect(fake.execute).toHaveBeenCalledTimes(1);

    const [rows, orderIds] = bound(fake);

    expect(JSON.parse(String(rows))).toEqual([
      { refund_line_id: 'rl-1', line_item_ids: ['gid://shopify/LineItem/1', '1'], quantity: 1 },
    ]);
    expect(JSON.parse(String(orderIds))).toEqual(['gid://shopify/Order/1', '1']);
    expect(bound(fake)).toHaveLength(2);
  });

  it('writes an entry and edits nothing', async () => {
    const fake = fakeTx([]);

    await recordRefunds(fake.tx, REFUND);

    expect(said(fake)).toMatch(/INSERT INTO attributions/u);
    expect(said(fake)).not.toMatch(/UPDATE|DELETE/u);
    expect(said(fake)).toMatch(
      /ON CONFLICT \(tenant_id, refund_line_id\) WHERE refund_line_id IS NOT NULL DO NOTHING/u,
    );
  });

  it('joins to a sale, so a refund for a line that was never ours writes nothing', async () => {
    const fake = fakeTx([]);

    expect(await recordRefunds(fake.tx, REFUND)).toBe(0);
    expect(said(fake)).toMatch(/JOIN attributions s\s/u);
    expect(said(fake)).toMatch(/ON s\.refund_line_id IS NULL\s+AND s\.order_id IN/u);
  });
});

describe('the privacy statements (P6-09b)', () => {
  const ORDERS = ['gid://shopify/Order/1', '1'];

  it('ask the database nothing for no orders', async () => {
    const fake = fakeTx();

    expect(await countOrderEntries(fake.tx, [])).toBe(0);
    expect(await eraseOrders(fake.tx, [])).toBe(0);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('count what is held for the orders, in both spellings, without touching it', async () => {
    const fake = fakeTx([{ held: 3 }]);

    expect(await countOrderEntries(fake.tx, ORDERS)).toBe(3);
    expect(JSON.parse(String(bound(fake)[0]))).toEqual(ORDERS);
    expect(said(fake)).toMatch(/SELECT count/u);
    expect(said(fake)).not.toMatch(/DELETE|UPDATE|INSERT/u);
  });

  it('count nothing when the database has nothing to say', async () => {
    expect(await countOrderEntries(fakeTx([]).tx, ORDERS)).toBe(0);
  });

  it('erase by order, sale and refund alike, and say how many went', async () => {
    const fake = fakeTx([{ id: 'a-1' }, { id: 'a-2' }]);

    expect(await eraseOrders(fake.tx, ORDERS)).toBe(2);
    expect(JSON.parse(String(bound(fake)[0]))).toEqual(ORDERS);
    expect(said(fake)).toMatch(/DELETE FROM attributions\s+WHERE order_id IN/u);
    expect(said(fake)).not.toMatch(/refund_line_id/u);
  });

  it('erase by shop, naming the shop and no tenant', async () => {
    const fake = fakeTx([{ id: 'a-1' }]);

    expect(await eraseShop(fake.tx, 'cantina-rossi.myshopify.com')).toBe(1);
    expect(bound(fake)).toEqual(['cantina-rossi.myshopify.com']);
    expect(said(fake)).toMatch(/DELETE FROM attributions WHERE shop =/u);
    expect(said(fake)).not.toMatch(/tenant_id/u);
  });
});
