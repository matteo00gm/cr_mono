import { createHmac } from 'node:crypto';

import { expect, test, type Browser, type Page } from '@playwright/test';

import { start, type Harness } from './setup.js';

/**
 * What the sommelier sold, end to end (P6-08, §2.4).
 *
 * **The number a seller pays for, followed from a question to an order.** A
 * shopper asks, is shown a wine, adds it; Shopify later reports an order; and
 * exactly the lines the widget added are counted, for the visit and the
 * conversation they came from. P6-07 proves each rule on its own. What only a
 * browser can prove is that the pieces agree: the value the widget plants on a
 * cart line is the one its own events carry, which is the one an order is
 * matched by — three places, written months apart, that have to say the same
 * thing.
 *
 * **Shopify is the only thing that is simulated**, and only its voice: the
 * order and the refund are bodies of the shape it sends, signed with the app
 * secret, posted to the real route. The cart line they are built from is the
 * one the real widget really sent to the storefront.
 */

let harness: Harness;

test.beforeAll(async () => {
  test.setTimeout(180_000);
  harness = await start({ shopify: true });
});

test.afterAll(async () => {
  await harness.close();
});

test.beforeEach(async () => {
  harness.verified.reset();
  /* Each test opens the widget more than once; none of them is about the limit. */
  harness.nextMinute();
  await harness.api.reverifyDomain();
});

const QUESTION = 'Un rosso strutturato';

const widget = (page: Page) => page.locator('sommelier-widget');
const launcher = (page: Page) => widget(page).locator('button').first();
const panel = (page: Page) => widget(page).locator('.panel');

interface CartLine {
  readonly id: string;
  readonly properties: Readonly<Record<string, string>>;
}

/** What one shopper's visit left behind: the cart line, and the visit it names. */
interface Visit {
  readonly line: CartLine;
  /** `_somm_session`, as the widget planted it. */
  readonly visitorId: string;
  /** The conversation the widget's own events tied that visit to. */
  readonly conversationId: string;
}

/**
 * A shopper asks, is shown the wine and adds it to the shop's cart.
 *
 * Waits for the widget's own account of the visit to land — the `ADD_TO_CART`
 * event, under the visit and tied to its conversation — because that is what
 * an order is believed by, and in life an order is minutes behind it.
 */
const shop = async (page: Page, question = QUESTION): Promise<Visit> => {
  const before = harness.verified.calls().length;

  await page.goto(harness.verified.origin);
  await launcher(page).click();

  const composer = panel(page).locator('.composer-input');

  await composer.fill(question);
  await composer.press('Enter');

  const add = panel(page).locator('.card-add').first();

  await expect(add).toBeVisible();
  await add.click();

  await expect.poll(() => harness.verified.calls().length).toBe(before + 1);

  const body = harness.verified.calls().at(-1)?.body as { items: CartLine[] };
  const line = body.items[0];

  if (line === undefined) throw new Error('The widget added no line to the cart.');

  const visitorId = line.properties._somm_session ?? '';

  await expect
    .poll(async () =>
      (await harness.api.visitEvents(visitorId))
        .filter((event) => event.conversationId !== null)
        .map((event) => event.type),
    )
    .toContain('ADD_TO_CART');

  const conversationId = (await harness.api.visitEvents(visitorId)).find(
    (event) => event.type === 'ADD_TO_CART',
  )?.conversationId;

  if (conversationId === null || conversationId === undefined) {
    throw new Error('The visit’s events found no conversation.');
  }

  return { line, visitorId, conversationId };
};

/** A second shopper, in a browser of their own: another tab's storage, so another visit. */
const shopAsSomeoneElse = async (browser: Browser, question: string): Promise<Visit> => {
  const context = await browser.newContext();

  try {
    return await shop(await context.newPage(), question);
  } finally {
    await context.close();
  }
};

let numbered = 1_000;

/** The next id Shopify would hand out, small enough for JSON to carry whole. */
const next = (): number => (numbered += 1);

interface OrderLine {
  readonly id: number;
  readonly [field: string]: unknown;
}

/** A line as Shopify reports the one the widget added: its variant, and every property it carried. */
const reported = (line: CartLine, overrides: Record<string, unknown> = {}): OrderLine => {
  const id = next();

  return {
    id,
    admin_graphql_api_id: `gid://shopify/LineItem/${String(id)}`,
    variant_id: Number(line.id),
    quantity: 1,
    price: '42.00',
    discount_allocations: [],
    properties: Object.entries(line.properties).map(([name, value]) => ({ name, value })),
    ...overrides,
  };
};

/** A line the shopper found on the storefront themselves: no widget, so no property. */
const foundThemselves = (price: string): OrderLine => {
  const id = next();

  return {
    id,
    admin_graphql_api_id: `gid://shopify/LineItem/${String(id)}`,
    variant_id: next(),
    quantity: 1,
    price,
    discount_allocations: [],
    properties: [],
  };
};

/** Delivers a webhook as Shopify does: the raw body, signed with the app secret. */
const deliver = async (topic: string, payload: unknown, secret?: string): Promise<string> => {
  const store = harness.shopify;

  if (store === undefined) throw new Error('The harness was started without a Shopify store.');

  const body = JSON.stringify(payload);
  const response = await fetch(`${harness.api.origin}/v1/webhooks/shopify`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'x-shopify-topic': topic,
      'x-shopify-shop-domain': store.shop,
      'x-shopify-hmac-sha256': createHmac('sha256', secret ?? store.secret)
        .update(body)
        .digest('base64'),
    },
    body,
  });

  if (response.status !== 200) return `refused:${String(response.status)}`;

  return ((await response.json()) as { result: string }).result;
};

/** An order placed on the storefront, as `orders/create` reports it. */
const order = async (lines: readonly OrderLine[]) => {
  const number = next();
  const orderId = `gid://shopify/Order/${String(number)}`;
  const result = await deliver('orders/create', {
    id: number,
    admin_graphql_api_id: orderId,
    currency: 'EUR',
    created_at: new Date().toISOString(),
    email: 'giulia.bianchi@example.com',
    line_items: lines,
  });

  return { number, orderId, result };
};

const worth = async (orderId: string): Promise<number> =>
  (await harness.api.attributions({ orderId })).reduce((sum, entry) => sum + entry.amountCents, 0);

test('a question, a recommendation and a cart line come to exactly one attribution', async ({
  page,
}) => {
  const visit = await shop(page);

  /* What the widget planted is the wine it showed, and a visit — not the session token. */
  expect(visit.line.id).toBe('45123456789');
  expect(visit.visitorId).toMatch(/^[A-Za-z0-9-]{8,64}$/u);

  const placed = await order([reported(visit.line)]);

  expect(placed.result).toBe('attributed');
  expect(await harness.api.attributions({ orderId: placed.orderId })).toEqual([
    {
      orderId: placed.orderId,
      sessionId: visit.visitorId,
      conversationId: visit.conversationId,
      productId: harness.api.productId,
      quantity: 1,
      amountCents: 4200,
      currency: 'EUR',
      refund: false,
    },
  ]);
  /* And it is *that* conversation: the one where this shopper asked this. */
  expect(await harness.api.questionsIn(visit.conversationId)).toEqual([QUESTION]);
});

test('a partial order attributes only the wine we recommended', async ({ page }) => {
  const visit = await shop(page);

  const placed = await order([
    foundThemselves('18.00'),
    reported(visit.line, { quantity: 2, discount_allocations: [{ amount: '8.40' }] }),
    foundThemselves('65.00'),
  ]);

  expect(placed.result).toBe('attributed');

  const entries = await harness.api.attributions({ orderId: placed.orderId });

  /* 2 × 42.00 less 8.40: what was paid for ours, and none of the 83.00 beside it. */
  expect(entries).toHaveLength(1);
  expect(entries[0]).toMatchObject({ quantity: 2, amountCents: 7560, sessionId: visit.visitorId });
});

test('a refund reduces it, by what came back and once', async ({ page }) => {
  const visit = await shop(page);
  const sold = reported(visit.line, { quantity: 2 });
  const placed = await order([sold, foundThemselves('18.00')]);

  expect(await worth(placed.orderId)).toBe(8400);

  const refund = {
    id: next(),
    order_id: placed.number,
    note: 'Una bottiglia è arrivata rotta',
    refund_line_items: [{ id: next(), line_item_id: sold.id, quantity: 1, subtotal: '42.00' }],
  };

  expect(await deliver('refunds/create', refund)).toBe('reduced');
  expect(await worth(placed.orderId)).toBe(4200);

  /* Shopify redelivers; the bottle came back once. */
  expect(await deliver('refunds/create', refund)).toBe('nothing');
  expect(await worth(placed.orderId)).toBe(4200);

  /* The sale is still there as it was written, with the refund beside it. */
  expect(
    (await harness.api.attributions({ orderId: placed.orderId })).map((entry) => [
      entry.refund,
      entry.quantity,
      entry.amountCents,
    ]),
  ).toEqual([
    [false, 2, 8400],
    [true, -1, -4200],
  ]);
});

test('two sessions in one order attribute separately', async ({ page, browser }) => {
  const first = await shop(page, 'Un rosso per la bistecca');
  const second = await shopAsSomeoneElse(browser, 'Un regalo per mio padre');

  expect(second.visitorId).not.toBe(first.visitorId);
  expect(second.conversationId).not.toBe(first.conversationId);

  const placed = await order([
    reported(first.line, { price: '42.00' }),
    reported(second.line, { price: '30.00' }),
  ]);

  expect(placed.result).toBe('attributed');
  expect(
    (await harness.api.attributions({ orderId: placed.orderId })).map((entry) => ({
      sessionId: entry.sessionId,
      conversationId: entry.conversationId,
      amountCents: entry.amountCents,
    })),
  ).toEqual([
    { sessionId: second.visitorId, conversationId: second.conversationId, amountCents: 3000 },
    { sessionId: first.visitorId, conversationId: first.conversationId, amountCents: 4200 },
  ]);
  expect(await harness.api.questionsIn(first.conversationId)).toEqual(['Un rosso per la bistecca']);
  expect(await harness.api.questionsIn(second.conversationId)).toEqual(['Un regalo per mio padre']);
});

test('a session with no order attributes nothing', async ({ page }) => {
  const visit = await shop(page);

  /* Somebody else's order arrives meanwhile, with nothing of ours in it. */
  const placed = await order([foundThemselves('18.00')]);

  expect(placed.result).toBe('nothing');
  expect(await harness.api.attributions({ sessionId: visit.visitorId })).toEqual([]);
  expect(await harness.api.attributions({ orderId: placed.orderId })).toEqual([]);
});

test('an order nobody signed attributes nothing, whatever it claims', async ({ page }) => {
  const visit = await shop(page);
  const number = next();
  const orderId = `gid://shopify/Order/${String(number)}`;

  expect(
    await deliver(
      'orders/create',
      {
        id: number,
        admin_graphql_api_id: orderId,
        currency: 'EUR',
        line_items: [reported(visit.line)],
      },
      'not-the-app-secret',
    ),
  ).toBe('refused:401');
  expect(await harness.api.attributions({ orderId })).toEqual([]);
});

test('a visit copied onto a cart from nowhere is not believed', async () => {
  /* Anyone can type a property onto a cart line. No visit of this winery's, no attribution. */
  const placed = await order([
    reported({
      id: '45123456789',
      properties: { _somm_session: '00000000-0000-4000-8000-000000000000' },
    }),
  ]);

  expect(placed.result).toBe('nothing');
  expect(await harness.api.attributions({ orderId: placed.orderId })).toEqual([]);
});
