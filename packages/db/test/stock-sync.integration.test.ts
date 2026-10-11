import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { syncStock, type StockReport, type StockToSync } from '../src/stock-sync.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Stock as a seller's shop reports it, against real Postgres (P6-11, §4.4).
 *
 * **What it must not do matters as much as what it does.** A stock update is
 * supposed to be nearly free — no outbox row, no embedding, no reshuffled
 * catalogue — and each of those is a property of triggers, policies and grants
 * that a fake would simply agree with.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;

const AT = (time: string): Date => new Date(`2026-10-05T${time}Z`);

let variantNumber = 45_000_000_000;

/** A wine with a Shopify variant, indexed, so an embedding would have something to redo. */
const addWine = async (stock: { status?: string; qty?: number | null } = {}): Promise<Wine> => {
  const variantId = String((variantNumber += 1));
  const inserted = await db.execute(sql`
    insert into products (
      tenant_id, sku, name, wine_type, price_cents, currency, stock_status, stock_qty,
      external_variant_id, content_hash, embedding_state
    )
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid, ${`SKU-${variantId}`}, 'Barolo',
      'RED', 4200, 'EUR', ${stock.status ?? 'IN_STOCK'}::product_stock_status, ${stock.qty ?? 12},
      ${variantId}, 'hash-of-what-the-model-read', 'INDEXED'
    )
    returning id
  `);

  return { id: String([...inserted][0]?.id), variantId };
};

interface Wine {
  readonly id: string;
  readonly variantId: string;
}

interface Stored {
  readonly stock_status: string;
  readonly stock_qty: number | null;
  readonly stock_source_at: Date | string | null;
  readonly updated_at: Date | string;
  readonly content_hash: string | null;
  readonly embedding_state: string;
}

const stored = async (wine: Wine): Promise<Stored> => {
  const rows = await db.execute(sql`
    select stock_status, stock_qty, stock_source_at, updated_at, content_hash, embedding_state
    from products where id = ${wine.id}::uuid
  `);

  return [...rows][0] as unknown as Stored;
};

const stockOf = async (wine: Wine) => {
  const row = await stored(wine);

  return { status: row.stock_status, qty: row.stock_qty };
};

const outboxRows = async (): Promise<number> =>
  Number([...(await db.execute(sql`select count(*)::int as n from outbox`))][0]?.n);

const report = (
  wine: Wine,
  stock: Partial<StockToSync>,
  sourceAt: Date | undefined = AT('10:00:00'),
): StockReport => ({
  sourceAt,
  variants: [{ variantId: wine.variantId, status: 'IN_STOCK', quantity: 6, ...stock }],
});

const sync = (stock: StockReport, scope = tenantId) =>
  withTenant(scope, (tx) => syncStock(tx, stock), db);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  otherTenantId = await createTenant(db, 'altra-giacenza');
  tenantId = await createTenant(db, 'giacenza');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('a report from the shop', () => {
  it('sells a wine out', async () => {
    const wine = await addWine();

    expect(await sync(report(wine, { status: 'OUT_OF_STOCK', quantity: 0 }))).toBe(1);
    expect(await stockOf(wine)).toEqual({ status: 'OUT_OF_STOCK', qty: 0 });
  });

  it('brings one back, with the bottles there are', async () => {
    const wine = await addWine({ status: 'OUT_OF_STOCK', qty: 0 });

    await sync(report(wine, { status: 'IN_STOCK', quantity: 24 }));

    expect(await stockOf(wine)).toEqual({ status: 'IN_STOCK', qty: 24 });
  });

  it('records a wine the shop does not count as in stock, with no number', async () => {
    const wine = await addWine({ status: 'OUT_OF_STOCK', qty: 0 });

    await sync(report(wine, { status: 'IN_STOCK', quantity: null }));

    expect(await stockOf(wine)).toEqual({ status: 'IN_STOCK', qty: null });
  });

  it('records one that can still be ordered at none', async () => {
    const wine = await addWine();

    await sync(report(wine, { status: 'PREORDER', quantity: 0 }));

    expect(await stockOf(wine)).toEqual({ status: 'PREORDER', qty: 0 });
  });

  it('moves several wines in one statement', async () => {
    const [first, second] = [await addWine(), await addWine()];

    expect(
      await sync({
        sourceAt: AT('10:00:00'),
        variants: [
          { variantId: first.variantId, status: 'OUT_OF_STOCK', quantity: 0 },
          { variantId: second.variantId, status: 'IN_STOCK', quantity: 3 },
        ],
      }),
    ).toBe(2);
    expect(await stockOf(first)).toEqual({ status: 'OUT_OF_STOCK', qty: 0 });
    expect(await stockOf(second)).toEqual({ status: 'IN_STOCK', qty: 3 });
  });

  it('ignores a variant the catalogue does not hold, without an error', async () => {
    const wine = await addWine();

    expect(
      await sync({
        sourceAt: AT('10:00:00'),
        variants: [
          { variantId: '999999999999', status: 'OUT_OF_STOCK', quantity: 0 },
          { variantId: wine.variantId, status: 'IN_STOCK', quantity: 2 },
        ],
      }),
    ).toBe(1);
    expect(await stockOf(wine)).toEqual({ status: 'IN_STOCK', qty: 2 });
  });

  it('is stamped now when the shop did not say when', async () => {
    const wine = await addWine();

    /* Spelled out: `report(wine, …, undefined)` would be handed the default moment. */
    await sync({
      sourceAt: undefined,
      variants: [{ variantId: wine.variantId, status: 'IN_STOCK', quantity: 2 }],
    });

    const at = new Date((await stored(wine)).stock_source_at ?? 0).getTime();

    expect(Math.abs(Date.now() - at)).toBeLessThan(60_000);
  });
});

describe('what a stock report costs', () => {
  it('writes no outbox row and touches nothing the embedding was made from', async () => {
    /*
     * **The invariant that makes this cheap** (P1-33). Stock is not in the
     * text a wine is embedded from, so a wine selling out is one `UPDATE` and
     * no model call. A statement that enqueued "just in case" would re-embed a
     * seller's catalogue every busy afternoon.
     */
    const wine = await addWine();
    const before = await outboxRows();

    await sync(report(wine, { status: 'OUT_OF_STOCK', quantity: 0 }));

    expect(await outboxRows()).toBe(before);
    expect(await stored(wine)).toMatchObject({
      content_hash: 'hash-of-what-the-model-read',
      embedding_state: 'INDEXED',
    });
  });

  it('does not move the wine in "recently edited": the shop sold a bottle, nobody edited anything', async () => {
    /* `updated_at` is a sort field sellers use (P1-06, migration 0038). */
    const wine = await addWine();
    const before = String((await stored(wine)).updated_at);

    await sync(report(wine, { status: 'OUT_OF_STOCK', quantity: 0 }));

    expect(String((await stored(wine)).updated_at)).toBe(before);
  });

  it('still counts a seller changing stock by hand as an edit', async () => {
    /* The other half: the trigger was narrowed for the shop's reports, not for stock. */
    const wine = await addWine();
    const before = String((await stored(wine)).updated_at);

    await db.execute(sql`update products set stock_qty = 3 where id = ${wine.id}::uuid`);

    expect(String((await stored(wine)).updated_at)).not.toBe(before);
  });

  it('still counts an edit made in the same statement as a report', async () => {
    /* A clock that moves does not excuse a name that changed with it. */
    const wine = await addWine();
    const before = String((await stored(wine)).updated_at);

    await db.execute(sql`
      update products set stock_source_at = now(), stock_qty = 1, name = 'Barolo Riserva'
      where id = ${wine.id}::uuid
    `);

    expect(String((await stored(wine)).updated_at)).not.toBe(before);
  });
});

describe('reports out of order', () => {
  it('lets the later word stand when an older one arrives after it', async () => {
    /* A redelivery: sold out at 10:05, and then the 10:00 "six left" turns up. */
    const wine = await addWine();

    await sync(report(wine, { status: 'OUT_OF_STOCK', quantity: 0 }, AT('10:05:00')));

    expect(await sync(report(wine, { status: 'IN_STOCK', quantity: 6 }, AT('10:00:00')))).toBe(0);
    expect(await stockOf(wine)).toEqual({ status: 'OUT_OF_STOCK', qty: 0 });
  });

  it('applies a newer one, and remembers when it was true', async () => {
    const wine = await addWine();

    await sync(report(wine, { quantity: 6 }, AT('10:00:00')));
    expect(await sync(report(wine, { quantity: 5 }, AT('10:00:01')))).toBe(1);

    expect(await stockOf(wine)).toEqual({ status: 'IN_STOCK', qty: 5 });
    expect(new Date((await stored(wine)).stock_source_at ?? 0).toISOString()).toBe(
      '2026-10-05T10:00:01.000Z',
    );
  });

  it('writes nothing for the same report again', async () => {
    const wine = await addWine();
    const same = report(wine, { status: 'OUT_OF_STOCK', quantity: 0 }, AT('10:00:00'));

    expect(await sync(same)).toBe(1);
    expect(await sync(same)).toBe(0);
    expect(await sync(same)).toBe(0);
  });

  it('applies a different report from the same second', async () => {
    /* Two bottles sold within a second: Shopify's clock does not tell them apart, the count does. */
    const wine = await addWine();

    await sync(report(wine, { quantity: 6 }, AT('10:00:00')));

    expect(await sync(report(wine, { quantity: 5 }, AT('10:00:00')))).toBe(1);
    expect(await stockOf(wine)).toEqual({ status: 'IN_STOCK', qty: 5 });
  });

  it('moves the clock on even when the stock is what it already was', async () => {
    /*
     * Six, then five, then six again. If the second "six" did not move the
     * clock, the late "five" would look newer than what is stored and win.
     */
    const wine = await addWine();

    await sync(report(wine, { quantity: 6 }, AT('10:00:00')));
    await sync(report(wine, { quantity: 6 }, AT('10:00:10')));

    expect(await sync(report(wine, { quantity: 5 }, AT('10:00:05')))).toBe(0);
    expect(await stockOf(wine)).toEqual({ status: 'IN_STOCK', qty: 6 });
  });

  it('takes the first report for a wine whose stock was kept by hand', async () => {
    const wine = await addWine();

    expect((await stored(wine)).stock_source_at).toBeNull();
    expect(await sync(report(wine, { quantity: 1 }, AT('00:00:01')))).toBe(1);
  });
});

describe('whose wine it is', () => {
  it('never touches another winery’s wine, whatever variant the report names', async () => {
    await useTenant(db, otherTenantId);
    const theirs = await addWine();

    expect(await sync(report(theirs, { status: 'OUT_OF_STOCK', quantity: 0 }), tenantId)).toBe(0);

    await useTenant(db, otherTenantId);
    expect(await stockOf(theirs)).toEqual({ status: 'IN_STOCK', qty: 12 });
  });

  it('asks the database nothing for a report with no variants', async () => {
    let statements = 0;

    await withTenant(
      tenantId,
      (tx) =>
        syncStock(
          new Proxy(tx, {
            get: (target, property, receiver) => {
              if (property === 'execute') statements += 1;
              return Reflect.get(target, property, receiver) as unknown;
            },
          }),
          { sourceAt: AT('10:00:00'), variants: [] },
        ),
      db,
    );

    expect(statements).toBe(0);
  });

  it('refuses a count below nothing: the column counts bottles', async () => {
    const wine = await addWine();
    const error = await sync(report(wine, { quantity: -1 })).catch((caught: unknown) => caught);

    expect((error as { cause?: { code?: string } }).cause?.code).toBe('23514');
  });
});
