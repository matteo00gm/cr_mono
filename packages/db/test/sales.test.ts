import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { readAttributedSales } from '../src/sales.js';
import { hasInstalledShop } from '../src/shopify.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * What the sommelier sold over a range, without a database (P6-10): what the
 * statement says and binds, and how its rows are read back. The arithmetic is
 * real Postgres, in `sales.integration.test.ts`.
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

const RANGE = {
  start: new Date('2026-09-01T00:00:00.000Z'),
  end: new Date('2026-10-01T00:00:00.000Z'),
};

describe('readAttributedSales', () => {
  it('reads the range as a half-open one, in one statement', async () => {
    const fake = fakeTx([]);

    await readAttributedSales(fake.tx, RANGE);

    expect(fake.execute).toHaveBeenCalledTimes(1);
    expect(bound(fake)).toEqual(['2026-09-01T00:00:00.000Z', '2026-10-01T00:00:00.000Z']);
    expect(said(fake)).toMatch(/ordered_at >=/u);
    expect(said(fake)).toMatch(/ordered_at </u);
  });

  it('sums each line before deciding whether it counts', async () => {
    /* Net of refunds: a sale and what was taken back are one line, and one with nothing left is none. */
    const fake = fakeTx([]);

    await readAttributedSales(fake.tx, RANGE);

    expect(said(fake)).toMatch(/GROUP BY order_id, line_item_id, currency/u);
    expect(said(fake)).toMatch(/WHERE units > 0/u);
  });

  it('names no tenant, because the policy is what scopes it', async () => {
    const fake = fakeTx([]);

    await readAttributedSales(fake.tx, RANGE);

    expect(said(fake)).not.toMatch(/tenant_id/u);
  });

  it('gives back the totals once and each currency’s amount', async () => {
    const fake = fakeTx([
      { orders: 3, visits: 2, units: 5, currency: 'CHF', cents: 12_000 },
      { orders: 3, visits: 2, units: 5, currency: 'EUR', cents: 6050 },
    ]);

    expect(await readAttributedSales(fake.tx, RANGE)).toEqual({
      orders: 3,
      visits: 2,
      units: 5,
      amounts: [
        { currency: 'CHF', cents: 12_000 },
        { currency: 'EUR', cents: 6050 },
      ],
    });
  });

  it('gives back noughts and no amount for a range with no sales', async () => {
    /* The totals' row is always there; with nothing sold it has no currency beside it. */
    expect(
      await readAttributedSales(
        fakeTx([{ orders: 0, visits: 0, units: 0, currency: null, cents: null }]).tx,
        RANGE,
      ),
    ).toEqual({ orders: 0, visits: 0, units: 0, amounts: [] });
    expect(await readAttributedSales(fakeTx([]).tx, RANGE)).toEqual({
      orders: 0,
      visits: 0,
      units: 0,
      amounts: [],
    });
  });
});

describe('hasInstalledShop', () => {
  it('is true for a winery with a shop still installed, and false otherwise', async () => {
    expect(await hasInstalledShop(fakeTx([{ connected: true }]).tx)).toBe(true);
    expect(await hasInstalledShop(fakeTx([{ connected: false }]).tx)).toBe(false);
    expect(await hasInstalledShop(fakeTx([]).tx)).toBe(false);
  });

  it('asks about installed shops only, and names no tenant', async () => {
    const fake = fakeTx([{ connected: true }]);

    await hasInstalledShop(fake.tx);

    expect(said(fake)).toMatch(/uninstalled_at is null/u);
    expect(said(fake)).not.toMatch(/tenant_id/u);
    expect(bound(fake)).toEqual([]);
  });
});
