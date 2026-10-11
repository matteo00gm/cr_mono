import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  recordAttributions,
  type LineToAttribute,
  type OrderToAttribute,
} from '../src/attributions.js';
import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { recordWidgetEvents } from '../src/widget-events.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * What the sommelier sold, against real Postgres (P6-07).
 *
 * **Whose visit a line carries is the case this file exists for.** The value
 * on a cart line is typed by whoever fills the cart, so it is believed only
 * when it names a visit this winery had — read under the scope's own policy,
 * where another winery's visits do not exist. A fake cannot show that: it
 * returns whatever it is told to.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

const SHOP = 'cantina-rossi.myshopify.com';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;
let barolo: string;

const addProduct = async (sku: string, variantId: string | null): Promise<string> => {
  const inserted = await db.execute(sql`
    insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status, external_variant_id)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${sku}, 'Barolo', 'RED', 4200, 'EUR', 'IN_STOCK', ${variantId})
    returning id
  `);

  return String([...inserted][0]?.id);
};

/** A visit as the widget leaves one: a conversation, and events grouped by the per-tab id. */
const visit = async (scope = tenantId): Promise<{ visitorId: string; conversationId: string }> => {
  const visitorId = randomUUID();
  const widgetSessionId = randomUUID();

  const conversationId = await withTenant(
    scope,
    async (tx) => {
      const inserted = await tx.execute(sql`
        insert into conversations (tenant_id, session_id, origin, locale)
        values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${widgetSessionId}, 'https://winery.example', 'it')
        returning id
      `);

      await recordWidgetEvents(tx, {
        visitorId,
        widgetSessionId,
        events: [{ type: 'ADD_TO_CART', productId: null, at: new Date() }],
      });

      return String([...inserted][0]?.id);
    },
    db,
  );

  return { visitorId, conversationId };
};

const lineOf = (sessionId: string, overrides: Partial<LineToAttribute> = {}): LineToAttribute => ({
  lineItemId: `gid://shopify/LineItem/${randomUUID()}`,
  sessionId,
  variantId: '45123456789',
  quantity: 1,
  amountCents: 4200,
  ...overrides,
});

const orderOf = (
  lines: readonly LineToAttribute[],
  overrides: Partial<OrderToAttribute> = {},
): OrderToAttribute => ({
  shop: SHOP,
  orderId: `gid://shopify/Order/${randomUUID()}`,
  currency: 'EUR',
  orderedAt: new Date('2026-10-05T08:15:30.000Z'),
  lines,
  ...overrides,
});

const record = (order: OrderToAttribute, scope = tenantId) =>
  withTenant(scope, (tx) => recordAttributions(tx, order), db);

interface Row {
  readonly tenant_id: string;
  readonly shop: string;
  readonly order_id: string;
  readonly line_item_id: string;
  readonly session_id: string;
  readonly conversation_id: string | null;
  readonly product_id: string | null;
  readonly quantity: number;
  readonly amount_cents: number;
  readonly currency: string;
  readonly ordered_at: Date | string;
}

const rowsOf = async (orderId: string): Promise<Row[]> =>
  [
    ...(await db.execute(sql`
      select tenant_id, shop, order_id, line_item_id, session_id, conversation_id, product_id,
             quantity, amount_cents, currency, ordered_at
      from attributions where order_id = ${orderId}
      order by line_item_id
    `)),
  ] as unknown as Row[];

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  otherTenantId = await createTenant(db, 'altra-vendite');
  await addProduct('SKU-ALTRA', '99999999999');

  tenantId = await createTenant(db, 'vendite');
  barolo = await addProduct('SKU-BAROLO', '45123456789');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await useTenant(db, tenantId);
});

describe('a line the widget added', () => {
  it('is recorded for the winery, with the visit, the conversation and the wine it found', async () => {
    const { visitorId, conversationId } = await visit();
    const order = orderOf([lineOf(visitorId, { quantity: 2, amountCents: 7400 })]);

    expect(await record(order)).toBe(1);

    expect(await rowsOf(order.orderId)).toEqual([
      {
        tenant_id: tenantId,
        shop: SHOP,
        order_id: order.orderId,
        line_item_id: order.lines[0]?.lineItemId,
        session_id: visitorId,
        conversation_id: conversationId,
        product_id: barolo,
        quantity: 2,
        amount_cents: 7400,
        currency: 'EUR',
        ordered_at: expect.anything() as unknown,
      },
    ]);
    expect(new Date((await rowsOf(order.orderId))[0]?.ordered_at ?? 0).toISOString()).toBe(
      '2026-10-05T08:15:30.000Z',
    );
  });

  it('is recorded once: a redelivered order adds nothing, and says so', async () => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId)]);

    expect(await record(order)).toBe(1);
    expect(await record(order)).toBe(0);
    /* Even one that has changed its mind about the amount. */
    expect(
      await record({ ...order, lines: order.lines.map((line) => ({ ...line, amountCents: 1 })) }),
    ).toBe(0);

    expect((await rowsOf(order.orderId)).map(({ amount_cents }) => amount_cents)).toEqual([4200]);
  });

  it('is recorded per line: two of ours in one order are two rows, and a later line is added', async () => {
    const { visitorId } = await visit();
    const [first, second, third] = [lineOf(visitorId), lineOf(visitorId), lineOf(visitorId)];
    const order = orderOf([first, second]);

    expect(await record(order)).toBe(2);
    expect(await record({ ...order, lines: [first, second, third] })).toBe(1);
    expect(await rowsOf(order.orderId)).toHaveLength(3);
  });

  it('keeps two visits in one order apart, each with its own conversation', async () => {
    const [one, two] = [await visit(), await visit()];
    const order = orderOf([
      lineOf(one.visitorId, { lineItemId: 'gid://shopify/LineItem/1' }),
      lineOf(two.visitorId, { lineItemId: 'gid://shopify/LineItem/2' }),
    ]);

    expect(await record(order)).toBe(2);
    expect(
      (await rowsOf(order.orderId)).map(({ session_id, conversation_id }) => ({
        session_id,
        conversation_id,
      })),
    ).toEqual([
      { session_id: one.visitorId, conversation_id: one.conversationId },
      { session_id: two.visitorId, conversation_id: two.conversationId },
    ]);
  });

  it('is still a sale when the wine is not one the catalogue knows', async () => {
    const { visitorId } = await visit();
    const order = orderOf([
      lineOf(visitorId, { lineItemId: 'gid://shopify/LineItem/1', variantId: '11111111111' }),
      lineOf(visitorId, { lineItemId: 'gid://shopify/LineItem/2', variantId: null }),
    ]);

    expect(await record(order)).toBe(2);
    expect((await rowsOf(order.orderId)).map(({ product_id }) => product_id)).toEqual([null, null]);
  });

  it('is stamped now when Shopify did not say when', async () => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId)], { orderedAt: undefined });

    await record(order);

    const [row] = await rowsOf(order.orderId);

    expect(Math.abs(Date.now() - new Date(row?.ordered_at ?? 0).getTime())).toBeLessThan(60_000);
  });
});

describe('a line that is not ours', () => {
  it('is not recorded for a visit nobody had', async () => {
    const order = orderOf([lineOf(randomUUID())]);

    expect(await record(order)).toBe(0);
    expect(await rowsOf(order.orderId)).toEqual([]);
  });

  it('is not recorded for another winery’s visit, copied onto this shop’s cart', async () => {
    const theirs = await visit(otherTenantId);
    const order = orderOf([lineOf(theirs.visitorId)]);

    expect(await record(order)).toBe(0);
    expect(await rowsOf(order.orderId)).toEqual([]);
  });

  it('does not take the others down with it', async () => {
    const { visitorId } = await visit();
    const order = orderOf([
      lineOf(randomUUID(), { lineItemId: 'gid://shopify/LineItem/1' }),
      lineOf(visitorId, { lineItemId: 'gid://shopify/LineItem/2' }),
    ]);

    expect(await record(order)).toBe(1);
    expect((await rowsOf(order.orderId)).map(({ line_item_id }) => line_item_id)).toEqual([
      'gid://shopify/LineItem/2',
    ]);
  });

  it('never names another winery’s wine, whatever variant the line carries', async () => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId, { variantId: '99999999999' })]);

    await record(order);

    expect((await rowsOf(order.orderId))[0]?.product_id).toBeNull();
  });

  it('asks the database nothing for an order with no lines', async () => {
    let statements = 0;

    await withTenant(
      tenantId,
      (tx) =>
        recordAttributions(
          new Proxy(tx, {
            get: (target, property, receiver) => {
              if (property === 'execute') statements += 1;
              return Reflect.get(target, property, receiver) as unknown;
            },
          }),
          orderOf([]),
        ),
      db,
    );

    expect(statements).toBe(0);
  });
});

describe('the table', () => {
  it('shows a winery only its own sales', async () => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId)]);

    await record(order);

    await useTenant(db, otherTenantId);
    expect(await rowsOf(order.orderId)).toEqual([]);
  });

  it('lets the same order line be another winery’s too, rather than refusing one of them', async () => {
    /* The key is per winery: one winery's rows are invisible to the other's insert. */
    const [ours, theirs] = [await visit(), await visit(otherTenantId)];
    const lineItemId = 'gid://shopify/LineItem/condivisa';
    const orderId = `gid://shopify/Order/${randomUUID()}`;

    expect(await record(orderOf([lineOf(ours.visitorId, { lineItemId })], { orderId }))).toBe(1);
    expect(
      await record(orderOf([lineOf(theirs.visitorId, { lineItemId })], { orderId }), otherTenantId),
    ).toBe(1);
  });

  it('cannot be rewritten by the runtime role: an amount is written once', async () => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId)]);

    await record(order);

    const error = await db
      .execute(sql`update attributions set amount_cents = 1 where order_id = ${order.orderId}`)
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });

  it('can be emptied for a shop, as Shopify may require', async () => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId)]);

    await record(order);
    await db.execute(sql`delete from attributions where order_id = ${order.orderId}`);

    expect(await rowsOf(order.orderId)).toEqual([]);
  });

  it.each([
    ['a quantity of none', { quantity: 0 }],
    ['an amount below nothing', { amountCents: -1 }],
  ])('refuses %s', async (_, overrides) => {
    const { visitorId } = await visit();
    const error = await record(orderOf([lineOf(visitorId, overrides)])).catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('refuses a currency that is not a code', async () => {
    const { visitorId } = await visit();
    const error = await record(orderOf([lineOf(visitorId)], { currency: 'euro' })).catch(
      (caught: unknown) => caught,
    );

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('keeps the sale when its conversation is purged', async () => {
    const { visitorId, conversationId } = await visit();
    const order = orderOf([lineOf(visitorId)]);

    await record(order);
    await db.execute(sql`delete from conversations where id = ${conversationId}::uuid`);

    expect(await rowsOf(order.orderId)).toMatchObject([
      { conversation_id: null, session_id: visitorId, amount_cents: 4200 },
    ]);
  });
});
