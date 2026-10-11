import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import { syncStock, type StockReport } from '../src/stock-sync.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * Stock as the shop reports it, without a database (P6-11): what the one
 * statement says and binds. What it costs, and which report wins, is real
 * Postgres in `stock-sync.integration.test.ts`.
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

const REPORT: StockReport = {
  sourceAt: new Date('2026-10-05T10:00:00.000Z'),
  variants: [
    { variantId: '45123456789', status: 'OUT_OF_STOCK', quantity: 0 },
    { variantId: '45123456790', status: 'IN_STOCK', quantity: null },
  ],
};

describe('syncStock', () => {
  it('asks the database nothing for a report with no variants', async () => {
    const fake = fakeTx();

    expect(await syncStock(fake.tx, { ...REPORT, variants: [] })).toBe(0);
    expect(fake.execute).not.toHaveBeenCalled();
  });

  it('sends every variant as one parameter, in one statement', async () => {
    const fake = fakeTx([{ id: 'p-1' }, { id: 'p-2' }]);

    expect(await syncStock(fake.tx, REPORT)).toBe(2);
    expect(fake.execute).toHaveBeenCalledTimes(1);

    const [sourceAt, rows] = bound(fake);

    expect(sourceAt).toBe('2026-10-05T10:00:00.000Z');
    expect(JSON.parse(String(rows))).toEqual([
      { variant_id: '45123456789', status: 'OUT_OF_STOCK', quantity: 0 },
      { variant_id: '45123456790', status: 'IN_STOCK', quantity: null },
    ]);
    expect(bound(fake)).toHaveLength(2);
  });

  it('counts the wines it changed, which for a repeat or an older report is none', async () => {
    expect(await syncStock(fakeTx([]).tx, REPORT)).toBe(0);
    expect(await syncStock(fakeTx([{ id: 'p-1' }]).tx, REPORT)).toBe(1);
  });

  it('sets the stock columns and the clock, and nothing else', async () => {
    const fake = fakeTx([]);

    await syncStock(fake.tx, REPORT);

    const set = /SET([\s\S]*?)FROM report r/u.exec(said(fake))?.[1] ?? '';

    expect(set.replaceAll(/\s+/gu, ' ').trim()).toBe(
      'stock_status = r.status, stock_qty = r.quantity, stock_source_at = r.source_at',
    );
  });

  it('enqueues nothing: a stock report is not a reason to embed', async () => {
    const fake = fakeTx([]);

    await syncStock(fake.tx, REPORT);

    expect(said(fake)).not.toMatch(/outbox|content_hash|embedding/iu);
    expect(said(fake)).not.toMatch(/INSERT|DELETE/u);
  });

  it('names no tenant, because the policy is what scopes it', async () => {
    const fake = fakeTx([]);

    await syncStock(fake.tx, REPORT);

    expect(said(fake)).not.toMatch(/tenant_id/u);
    expect(said(fake)).toMatch(/WHERE p\.external_variant_id = r\.variant_id/u);
  });

  it('holds a report to being the later word', async () => {
    const fake = fakeTx([]);

    await syncStock(fake.tx, REPORT);

    expect(said(fake)).toMatch(/p\.stock_source_at IS NULL/u);
    expect(said(fake)).toMatch(/p\.stock_source_at < r\.source_at/u);
    expect(said(fake)).toMatch(/IS DISTINCT FROM \(r\.status, r\.quantity\)/u);
  });

  it('leaves the moment to the database when the shop did not give one', async () => {
    const fake = fakeTx([]);

    await syncStock(fake.tx, { ...REPORT, sourceAt: undefined });

    expect(bound(fake)[0]).toBeNull();
    expect(said(fake)).toContain('now()');
  });
});
