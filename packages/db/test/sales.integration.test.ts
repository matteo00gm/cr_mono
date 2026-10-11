import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { readAttributedSales } from '../src/sales.js';
import { hasInstalledShop, markShopifyUninstalled, recordShopifyInstall } from '../src/shopify.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * What the sommelier sold over a range, against real Postgres (P6-10).
 *
 * The ledger is seeded directly — a sale, and beside it whatever a refund took
 * back — because what is held here is the arithmetic a seller will check
 * against their own order list: which lines count, in which range, and what
 * is left of each.
 */

const START = new Date('2026-09-01T00:00:00.000Z');
const END = new Date('2026-10-01T00:00:00.000Z');
const IN_RANGE = '2026-09-15T12:00:00.000Z';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let otherTenantId: string;

interface Entry {
  readonly order?: string;
  readonly line?: string;
  readonly visit?: string;
  readonly quantity?: number;
  readonly cents?: number;
  readonly currency?: string;
  readonly at?: string;
  /** Set for a refund's entry: negative quantity and amount, for the same order line. */
  readonly refund?: string;
}

/** One ledger entry, under whichever tenant the session is scoped to. */
const entry = ({
  order = `gid://shopify/Order/${randomUUID()}`,
  line = `gid://shopify/LineItem/${randomUUID()}`,
  visit = randomUUID(),
  quantity = 1,
  cents = 4200,
  currency = 'EUR',
  at = IN_RANGE,
  refund,
}: Entry = {}) =>
  db.execute(sql`
    insert into attributions (
      tenant_id, shop, order_id, line_item_id, session_id, quantity, amount_cents, currency,
      ordered_at, refund_line_id
    )
    values (
      nullif(current_setting('app.tenant_id', true), '')::uuid, 'cantina.myshopify.com',
      ${order}, ${line}, ${visit}, ${quantity}, ${cents}, ${currency}, ${at}::timestamptz,
      ${refund ?? null}
    )
  `);

/** A winery of its own for each test, so one test's ledger is not another's. */
const winery = async (): Promise<string> => createTenant(db, `vendite-${randomUUID().slice(0, 8)}`);

const read = (scope: string, start = START, end = END) =>
  withTenant(scope, (tx) => readAttributedSales(tx, { start, end }), db);

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  /* Another winery with sales of its own, which must never be counted for anybody else. */
  otherTenantId = await createTenant(db, 'altre-vendite');
  await entry({ quantity: 9, cents: 90_000 });
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, otherTenantId);
});

describe('what was sold', () => {
  it('is nothing for a winery that sold nothing', async () => {
    expect(await read(await winery())).toEqual({ orders: 0, visits: 0, units: 0, amounts: [] });
  });

  it('counts orders, visits, bottles and what was paid', async () => {
    const tenant = await winery();

    /* One order with two of our lines from one visit; another order from another visit. */
    await entry({ order: 'o-1', visit: 'v-1', quantity: 2, cents: 8400 });
    await entry({ order: 'o-1', visit: 'v-1', quantity: 1, cents: 1850 });
    await entry({ order: 'o-2', visit: 'v-2', quantity: 3, cents: 9000 });

    expect(await read(tenant)).toEqual({
      orders: 2,
      visits: 2,
      units: 6,
      amounts: [{ currency: 'EUR', cents: 19_250 }],
    });
  });

  it('counts one visit once, however many orders it placed', async () => {
    const tenant = await winery();

    await entry({ order: 'o-1', visit: 'v-1' });
    await entry({ order: 'o-2', visit: 'v-1' });

    expect(await read(tenant)).toMatchObject({ orders: 2, visits: 1 });
  });

  it('never counts another winery’s sales', async () => {
    const tenant = await winery();

    await entry({ cents: 100 });

    expect(await read(tenant)).toMatchObject({
      orders: 1,
      amounts: [{ currency: 'EUR', cents: 100 }],
    });
    /* And the other winery's nine bottles are still its own. */
    expect(await read(otherTenantId)).toMatchObject({ units: 9 });
  });
});

describe('after refunds', () => {
  it('takes what a refund took back off the bottles and the money', async () => {
    const tenant = await winery();

    await entry({ order: 'o-1', line: 'l-1', visit: 'v-1', quantity: 4, cents: 10_000 });
    await entry({
      order: 'o-1',
      line: 'l-1',
      visit: 'v-1',
      quantity: -1,
      cents: -2500,
      refund: 'r-1',
    });

    expect(await read(tenant)).toEqual({
      orders: 1,
      visits: 1,
      units: 3,
      amounts: [{ currency: 'EUR', cents: 7500 }],
    });
  });

  it('leaves a line refunded in full out of every number', async () => {
    /* Not an order with no bottles and no money: not there. */
    const tenant = await winery();

    await entry({ order: 'o-1', line: 'l-1', visit: 'v-1', quantity: 2, cents: 8400 });
    await entry({
      order: 'o-1',
      line: 'l-1',
      visit: 'v-1',
      quantity: -2,
      cents: -8400,
      refund: 'r-1',
    });

    expect(await read(tenant)).toEqual({ orders: 0, visits: 0, units: 0, amounts: [] });
  });

  it('keeps an order whose other line still stands', async () => {
    const tenant = await winery();

    await entry({ order: 'o-1', line: 'l-1', visit: 'v-1', quantity: 1, cents: 4200 });
    await entry({
      order: 'o-1',
      line: 'l-1',
      visit: 'v-1',
      quantity: -1,
      cents: -4200,
      refund: 'r-1',
    });
    await entry({ order: 'o-1', line: 'l-2', visit: 'v-1', quantity: 1, cents: 1850 });

    expect(await read(tenant)).toEqual({
      orders: 1,
      visits: 1,
      units: 1,
      amounts: [{ currency: 'EUR', cents: 1850 }],
    });
  });
});

describe('the range', () => {
  it('counts an order placed on its first instant, and not one on its last', async () => {
    const tenant = await winery();

    await entry({ order: 'first', at: '2026-09-01T00:00:00.000Z', cents: 100 });
    await entry({ order: 'before', at: '2026-08-31T23:59:59.999Z', cents: 1000 });
    await entry({ order: 'end', at: '2026-10-01T00:00:00.000Z', cents: 10_000 });

    expect(await read(tenant)).toMatchObject({
      orders: 1,
      amounts: [{ currency: 'EUR', cents: 100 }],
    });
  });

  it('takes a refund off the range its sale was counted in', async () => {
    /* A refund carries its sale's date (P6-08), whenever it was made. */
    const tenant = await winery();

    await entry({
      order: 'o-1',
      line: 'l-1',
      quantity: 2,
      cents: 8400,
      at: '2026-09-30T20:00:00.000Z',
    });
    await entry({
      order: 'o-1',
      line: 'l-1',
      quantity: -1,
      cents: -4200,
      refund: 'r-1',
      at: '2026-09-30T20:00:00.000Z',
    });

    expect(await read(tenant)).toMatchObject({
      units: 1,
      amounts: [{ currency: 'EUR', cents: 4200 }],
    });
    expect(
      await read(
        tenant,
        new Date('2026-10-01T00:00:00.000Z'),
        new Date('2026-11-01T00:00:00.000Z'),
      ),
    ).toEqual({ orders: 0, visits: 0, units: 0, amounts: [] });
  });
});

describe('more than one currency', () => {
  it('keeps each apart, largest first, with the orders and bottles of both', async () => {
    const tenant = await winery();

    await entry({ order: 'o-1', visit: 'v-1', cents: 4200, currency: 'EUR' });
    await entry({ order: 'o-2', visit: 'v-2', cents: 12_000, currency: 'CHF' });
    await entry({ order: 'o-3', visit: 'v-3', cents: 1850, currency: 'EUR' });

    expect(await read(tenant)).toEqual({
      orders: 3,
      visits: 3,
      units: 3,
      amounts: [
        { currency: 'CHF', cents: 12_000 },
        { currency: 'EUR', cents: 6050 },
      ],
    });
  });

  it('carries an amount past what a 32-bit sum would hold', async () => {
    const tenant = await winery();

    for (let order = 0; order < 3; order += 1) {
      await entry({ quantity: 1, cents: 2_000_000_000 });
    }

    expect((await read(tenant)).amounts).toEqual([{ currency: 'EUR', cents: 6_000_000_000 }]);
  });
});

describe('whether a sale can be seen', () => {
  const connected = (scope: string) => withTenant(scope, (tx) => hasInstalledShop(tx), db);
  const shop = (): string => `cantina-${randomUUID().slice(0, 8)}.myshopify.com`;
  const install = (scope: string, name: string) =>
    withTenant(scope, (tx) => recordShopifyInstall(tx, { shop: name, scopes: 'read_orders' }), db);

  it('cannot, for a winery that never connected a shop', async () => {
    expect(await connected(await winery())).toBe(false);
  });

  it('can, once a shop is connected', async () => {
    const tenant = await winery();

    await install(tenant, shop());

    expect(await connected(tenant)).toBe(true);
  });

  it('cannot again, once the shop has removed the app', async () => {
    const tenant = await winery();
    const name = shop();

    await install(tenant, name);
    await withTenant(tenant, (tx) => markShopifyUninstalled(tx, name), db);

    expect(await connected(tenant)).toBe(false);
  });

  it('still can while one of two shops is connected', async () => {
    const tenant = await winery();
    const [gone, kept] = [shop(), shop()];

    await install(tenant, gone);
    await install(tenant, kept);
    await withTenant(tenant, (tx) => markShopifyUninstalled(tx, gone), db);

    expect(await connected(tenant)).toBe(true);
  });

  it('is not made true by another winery’s shop', async () => {
    const [ours, theirs] = [await winery(), await winery()];

    await install(theirs, shop());

    expect(await connected(ours)).toBe(false);
  });
});
