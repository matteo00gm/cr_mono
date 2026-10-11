import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import {
  recordAttributions,
  recordRefunds,
  type LineToAttribute,
  type OrderToAttribute,
  type RefundToRecord,
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

const refund = (order: RefundToRecord, scope = tenantId) =>
  withTenant(scope, (tx) => recordRefunds(tx, order), db);

/** One line of a refund, for the sale's own line, under a fresh refund-line id. */
const back = (lineItemId: string, quantity: number, refundLineId = `rl-${randomUUID()}`) => ({
  refundLineId,
  lineItemIds: [lineItemId],
  quantity,
});

/** Every entry for an order: the sale first, then its refunds as they were written. */
const ledgerOf = async (orderId: string) =>
  [
    ...(await db.execute(sql`
      select refund_line_id, quantity, amount_cents
      from attributions where order_id = ${orderId}
      order by (refund_line_id is not null), created_at, amount_cents desc
    `)),
  ] as unknown as { refund_line_id: string | null; quantity: number; amount_cents: number }[];

/** What an order's lines are worth now: the sum of their entries. */
const worthOf = async (orderId: string) => {
  const [row] = [
    ...(await db.execute(sql`
      select coalesce(sum(amount_cents), 0)::int as cents, coalesce(sum(quantity), 0)::int as units
      from attributions where order_id = ${orderId}
    `)),
  ];

  return { cents: Number(row?.cents), units: Number(row?.units) };
};

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

describe('a refund (P6-08)', () => {
  /** A sale of ours: `quantity` bottles for `amountCents`, and the ids a refund will name. */
  const sale = async (quantity: number, amountCents: number) => {
    const { visitorId } = await visit();
    const order = orderOf([lineOf(visitorId, { quantity, amountCents })]);

    await record(order);

    return { orderId: order.orderId, lineItemId: order.lines[0]?.lineItemId ?? '' };
  };

  it('takes back the share of what was paid that the returned units were', async () => {
    const { orderId, lineItemId } = await sale(4, 10000);

    expect(await refund({ orderIds: [orderId], lines: [back(lineItemId, 1)] })).toBe(1);

    expect(await ledgerOf(orderId)).toMatchObject([
      { refund_line_id: null, quantity: 4, amount_cents: 10000 },
      { quantity: -1, amount_cents: -2500 },
    ]);
    expect(await worthOf(orderId)).toEqual({ cents: 7500, units: 3 });
  });

  it('leaves the sale’s own row exactly as it was written', async () => {
    const { orderId, lineItemId } = await sale(2, 8400);

    await refund({ orderIds: [orderId], lines: [back(lineItemId, 2)] });

    expect((await ledgerOf(orderId))[0]).toEqual({
      refund_line_id: null,
      quantity: 2,
      amount_cents: 8400,
    });
  });

  it('takes back everything when every unit comes back, to the cent', async () => {
    /* Three bottles for ten euros: a third each is 333, and the last takes what is left. */
    const { orderId, lineItemId } = await sale(3, 1000);

    for (let unit = 0; unit < 3; unit += 1) {
      await refund({ orderIds: [orderId], lines: [back(lineItemId, 1)] });
    }

    expect((await ledgerOf(orderId)).map(({ amount_cents }) => amount_cents)).toEqual([
      1000, -333, -333, -334,
    ]);
    expect(await worthOf(orderId)).toEqual({ cents: 0, units: 0 });
  });

  it('never takes back more than was sold, however much the refund claims', async () => {
    const { orderId, lineItemId } = await sale(2, 8400);

    expect(await refund({ orderIds: [orderId], lines: [back(lineItemId, 50)] })).toBe(1);
    expect(await worthOf(orderId)).toEqual({ cents: 0, units: 0 });

    /* And nothing is left for a second one to take. */
    expect(await refund({ orderIds: [orderId], lines: [back(lineItemId, 1)] })).toBe(0);
    expect(await worthOf(orderId)).toEqual({ cents: 0, units: 0 });
  });

  it('is counted once: a redelivered refund takes nothing more', async () => {
    const { orderId, lineItemId } = await sale(4, 10000);
    const line = back(lineItemId, 1, 'rl-una-volta');

    expect(await refund({ orderIds: [orderId], lines: [line] })).toBe(1);
    expect(await refund({ orderIds: [orderId], lines: [line] })).toBe(0);
    expect(await worthOf(orderId)).toEqual({ cents: 7500, units: 3 });
  });

  it('finds the sale under either spelling of its ids', async () => {
    const { visitorId } = await visit();
    const byGid = orderOf([lineOf(visitorId, { lineItemId: 'gid://shopify/LineItem/7001' })], {
      orderId: `gid://shopify/Order/${String(Date.now())}`,
    });
    const byNumber = orderOf([lineOf(visitorId, { lineItemId: '7002' })], {
      orderId: String(Date.now() + 1),
    });

    await record(byGid);
    await record(byNumber);

    const number = byGid.orderId.replace('gid://shopify/Order/', '');

    expect(
      await refund({
        orderIds: [`gid://shopify/Order/${number}`, number],
        lines: [
          {
            refundLineId: 'rl-gid',
            lineItemIds: ['gid://shopify/LineItem/7001', '7001'],
            quantity: 1,
          },
        ],
      }),
    ).toBe(1);
    expect(
      await refund({
        orderIds: [`gid://shopify/Order/${byNumber.orderId}`, byNumber.orderId],
        lines: [
          {
            refundLineId: 'rl-num',
            lineItemIds: ['gid://shopify/LineItem/7002', '7002'],
            quantity: 1,
          },
        ],
      }),
    ).toBe(1);
    expect(await worthOf(byGid.orderId)).toEqual({ cents: 0, units: 0 });
    expect(await worthOf(byNumber.orderId)).toEqual({ cents: 0, units: 0 });
  });

  it('reduces nothing for a line that was never ours', async () => {
    const { orderId } = await sale(1, 4200);

    expect(
      await refund({ orderIds: [orderId], lines: [back('gid://shopify/LineItem/altrui', 1)] }),
    ).toBe(0);
    expect(
      await refund({ orderIds: ['gid://shopify/Order/altro'], lines: [back('qualunque', 1)] }),
    ).toBe(0);
    expect(await worthOf(orderId)).toEqual({ cents: 4200, units: 1 });
  });

  it('is for the order it names: the same line under another order is not touched', async () => {
    /* Shopify's line ids do not repeat across orders, so this is belt and braces — and it is what
     * lets the lookup use the sale's own key. */
    const { orderId, lineItemId } = await sale(1, 4200);

    expect(
      await refund({ orderIds: ['gid://shopify/Order/un-altro'], lines: [back(lineItemId, 1)] }),
    ).toBe(0);
    expect(await worthOf(orderId)).toEqual({ cents: 4200, units: 1 });
  });

  it('reduces only the line it names, in an order with two of ours', async () => {
    const { visitorId } = await visit();
    const order = orderOf([
      lineOf(visitorId, { lineItemId: 'gid://shopify/LineItem/a', amountCents: 1000 }),
      lineOf(visitorId, { lineItemId: 'gid://shopify/LineItem/b', amountCents: 2000 }),
    ]);

    await record(order);
    await refund({ orderIds: [order.orderId], lines: [back('gid://shopify/LineItem/b', 1)] });

    expect(await worthOf(order.orderId)).toEqual({ cents: 1000, units: 1 });
  });

  it('cannot reach another winery’s sale', async () => {
    const { orderId, lineItemId } = await sale(1, 4200);

    expect(await refund({ orderIds: [orderId], lines: [back(lineItemId, 1)] }, otherTenantId)).toBe(
      0,
    );
    expect(await worthOf(orderId)).toEqual({ cents: 4200, units: 1 });
  });

  it('keeps a sale positive and a refund negative, whoever writes the row', async () => {
    const { orderId, lineItemId } = await sale(1, 4200);
    const row = (refundLineId: string | null, quantity: number, amountCents: number) =>
      db
        .execute(
          sql`insert into attributions (
                tenant_id, shop, order_id, line_item_id, session_id, quantity, amount_cents,
                currency, ordered_at, refund_line_id
              )
              values (${tenantId}::uuid, ${SHOP}, ${`${orderId}-x`}, ${lineItemId}, 'visit-0001',
                      ${quantity}, ${amountCents}, 'EUR', now(), ${refundLineId})`,
        )
        .catch((caught: unknown) => caught);

    expect(pgErrorCode(await row('rl-positivo', 1, 100))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await row(null, -1, -100))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await row(null, 1, -100))).toBe(CHECK_VIOLATION);
    expect(pgErrorCode(await row('rl-mezzo', -1, 100))).toBe(CHECK_VIOLATION);
  });
});
