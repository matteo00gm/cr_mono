import process from 'node:process';
import { createHmac, randomUUID } from 'node:crypto';

import { runWithRequestContext, TRIAL } from '@catalogorosso/core';
import { resolveTenantByShop } from '@catalogorosso/db';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createShopifyPort, type ShopifyPort } from '../src/shopify.js';
import { memoryShopifyTokens } from '../src/shopify-tokens.js';

/**
 * The Shopify install end to end against real Postgres (P6-06, ADR 0031):
 * started, signed, spent once, exchanged, recorded — and every forgery the
 * row names refused: a tampered signature, a replayed state, another
 * member's state, another winery's shop. The exchange is scripted; Shopify is
 * not called.
 */

/** Built at runtime, never written down (P0-56). */
const SECRET = ['shpss', 'int', 'c'.repeat(24)].join('_');

let harness: TestDatabase | undefined;
let db: TestDatabase['adminDb'];
let port: ShopifyPort;
const tokens = memoryShopifyTokens();
const exchanged: string[] = [];

interface Winery {
  readonly tenantId: string;
  readonly owner: string;
}

const winery = async (
  slug: string,
  plan: 'CANTINA' | 'ECOMMERCE' | null = 'ECOMMERCE',
): Promise<Winery> => {
  const tenantId = randomUUID();
  const owner = `owner_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  /* No plan is a winery that has only signed up: nothing verified, no trial yet. */
  await db.execute(
    plan === null
      ? sql`
          insert into tenants (id, name, slug, status, locale)
          values (${tenantId}::uuid, ${slug}, ${`${slug}-${tenantId}`}, 'PENDING_VERIFICATION', 'it')
        `
      : sql`
          insert into tenants (id, name, slug, status, plan, locale, stripe_subscription_id)
          values (${tenantId}::uuid, ${slug}, ${`${slug}-${tenantId}`}, 'ACTIVE', ${plan}, 'it',
                  'sub_' || gen_random_uuid())
        `,
  );
  await db.execute(sql`
    insert into auth_users (id, name, email) values (${owner}, 'Owner', ${`${owner}@example.com`})
  `);
  await db.execute(sql`
    insert into memberships (tenant_id, user_id, role) values (${tenantId}::uuid, ${owner}, 'OWNER')
  `);

  return { tenantId, owner };
};

const memberships = async (userId: string) =>
  [
    ...(await db.execute(sql`select tenant_id, role from memberships where user_id = ${userId}`)),
  ].map((row) => ({ tenantId: String(row.tenant_id), role: row.role as 'OWNER' | 'EDITOR' }));

/** Starts an install as the owner would, and returns the callback Shopify would send. */
const started = async (who: Winery, shop: string): Promise<URLSearchParams> => {
  const { url } = await port.install({ tenantId: who.tenantId, userId: who.owner, input: shop });
  const state = new URL(url).searchParams.get('state') ?? '';
  const params: Record<string, string> = {
    code: `code-${randomUUID()}`,
    /* What Shopify signs is the shop's permanent name, not what the owner typed. */
    shop: new URL(url).hostname,
    state,
    timestamp: String(Math.floor(Date.now() / 1000)),
  };
  const message = Object.keys(params)
    .sort()
    .map((name) => `${name}=${params[name] ?? ''}`)
    .join('&');

  return new URLSearchParams({
    ...params,
    hmac: createHmac('sha256', SECRET).update(message).digest('hex'),
  });
};

const callback = (userId: string, params: URLSearchParams) =>
  runWithRequestContext({ requestId: randomUUID() }, () =>
    port.callback({ userId, mfaEnabled: true, params }),
  );

const outcomeOf = (location: string) => Object.fromEntries(new URL(location).searchParams);

const domainOf = async (tenantId: string, origin: string) =>
  [
    ...(await db.execute(sql`
      select status, verification_method from tenant_domains
      where tenant_id = ${tenantId}::uuid and origin = ${origin}
    `)),
  ][0] as { status: string; verification_method: string | null } | undefined;

const billingOf = async (tenantId: string) =>
  [
    ...(await db.execute(sql`
      select status, round(extract(epoch from trial_ends_at - now()) / 86400)::int as trial_days
      from tenants where id = ${tenantId}::uuid
    `)),
  ][0] as { status: string; trial_days: number | null };

const auditOf = async (tenantId: string, action: string) =>
  [
    ...(await db.execute(sql`
      select target, metadata from audit_log
      where tenant_id = ${tenantId}::uuid and action = ${action}
    `)),
  ] as { target: string; metadata: Record<string, unknown> | null }[];

const cutoffsOf = async (tenantId: string, origin: string): Promise<number> =>
  [
    ...(await db.execute(sql`
      select 1 from widget_session_cutoffs
      where tenant_id = ${tenantId}::uuid and origin = ${origin}
    `)),
  ].length;

const uninstall = (shop: string, triggeredAt?: Date) =>
  runWithRequestContext({ requestId: randomUUID() }, () => port.uninstalled(shop, triggeredAt));

beforeAll(async () => {
  harness = await startTestDatabase();
  db = harness.adminDb;
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  port = createShopifyPort({
    config: { clientId: 'client-1', clientSecret: SECRET },
    redirectUri: 'https://app.example/v1/dashboard/shopify/callback',
    returnTo: 'https://app.example/integrazioni',
    tokens,
    readMemberships: memberships,
    exchange: (shop, code) => {
      exchanged.push(`${shop}:${code}`);
      return Promise.resolve({
        accessToken: `token-for-${shop}`,
        scope: 'read_products,read_orders',
      });
    },
  });
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

describe('an install that completes', () => {
  let rossi: Winery;
  const SHOP = 'cantina-rossi.myshopify.com';
  let params: URLSearchParams;

  beforeAll(async () => {
    rossi = await winery('rossi');
    params = await started(rossi, 'cantina-rossi');
  });

  it('sends the owner back connected, with the shop’s domain proved', async () => {
    expect(outcomeOf(await callback(rossi.owner, params))).toEqual({
      shopify: 'collegato',
      dominio: 'verificato',
    });
  });

  it('keeps the token where only this service reads it, and nowhere in the database', async () => {
    expect(tokens.read(rossi.tenantId, SHOP)).toBe(`token-for-${SHOP}`);

    const columns = [
      ...(await db.execute(sql`
        select column_name from information_schema.columns
        where table_name in ('shopify_installations', 'shopify_oauth_states')
      `)),
    ].map((row) => String(row.column_name));

    expect(columns.some((name) => name.includes('token'))).toBe(false);
  });

  it('records the shop as the winery’s, and finds it again by shop', async () => {
    expect(await resolveTenantByShop(SHOP)).toBe(rossi.tenantId);
    expect(await port.status(rossi.tenantId)).toMatchObject({
      configured: true,
      shop: { shop: SHOP, uninstalledAt: null },
    });
  });

  it('proves the myshopify.com origin by the third method (§3.3)', async () => {
    expect(await domainOf(rossi.tenantId, `https://${SHOP}`)).toEqual({
      status: 'VERIFIED',
      verification_method: 'SHOPIFY',
    });
  });

  it('audits the install under the winery, saying what became of the domain', async () => {
    expect(await auditOf(rossi.tenantId, 'shopify.installed')).toEqual([
      { target: SHOP, metadata: { status: 'verificato' } },
    ]);
  });

  it('starts no trial for a winery that already pays', async () => {
    expect(await billingOf(rossi.tenantId)).toEqual({ status: 'ACTIVE', trial_days: null });
    expect(await auditOf(rossi.tenantId, 'billing.trial_started')).toEqual([]);
  });

  it('refuses the same callback again: the state was spent', async () => {
    const before = exchanged.length;

    expect(outcomeOf(await callback(rossi.owner, params))).toMatchObject({ motivo: 'stato' });
    expect(exchanged).toHaveLength(before);
  });
});

describe('a forged or misdirected callback', () => {
  it('is refused when the signature was tampered with, and spends nothing', async () => {
    const bianchi = await winery('bianchi');
    const params = await started(bianchi, 'cantina-bianchi');
    const tampered = new URLSearchParams(params);

    tampered.set('code', 'a-code-of-my-choosing');

    expect(outcomeOf(await callback(bianchi.owner, tampered))).toMatchObject({ motivo: 'firma' });
    /* The genuine one still works: a forgery spent nothing. */
    expect(outcomeOf(await callback(bianchi.owner, params))).toMatchObject({
      shopify: 'collegato',
    });
  });

  it('is refused for another member, even an owner of the same winery', async () => {
    const verdi = await winery('verdi');
    const colleague = `owner_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

    await db.execute(sql`
      insert into auth_users (id, name, email) values (${colleague}, 'C', ${`${colleague}@example.com`})
    `);
    await db.execute(sql`
      insert into memberships (tenant_id, user_id, role) values (${verdi.tenantId}::uuid, ${colleague}, 'OWNER')
    `);

    const params = await started(verdi, 'cantina-verdi');

    expect(outcomeOf(await callback(colleague, params))).toMatchObject({ motivo: 'stato' });
    expect(outcomeOf(await callback(verdi.owner, params))).toMatchObject({ shopify: 'collegato' });
  });

  it('is refused when another winery already holds the shop, and no token is kept', async () => {
    const holder = await winery('detentore');
    const late = await winery('ritardo');
    const SHOP = 'contesa.myshopify.com';

    expect(outcomeOf(await callback(holder.owner, await started(holder, SHOP)))).toMatchObject({
      shopify: 'collegato',
    });
    expect(outcomeOf(await callback(late.owner, await started(late, SHOP)))).toMatchObject({
      motivo: 'occupato',
    });
    expect(tokens.read(late.tenantId, SHOP)).toBeUndefined();
    expect(await resolveTenantByShop(SHOP)).toBe(holder.tenantId);
  });
});

describe('the shop’s domain', () => {
  it('turns a pending one the winery added itself into a verified one', async () => {
    const neri = await winery('neri');
    const SHOP = 'cantina-neri.myshopify.com';

    await db.execute(sql`
      insert into tenant_domains (tenant_id, origin, registrable_domain, status, verification_token)
      values (${neri.tenantId}::uuid, ${`https://${SHOP}`}, ${SHOP}, 'PENDING', 'nonce')
    `);

    await callback(neri.owner, await started(neri, SHOP));

    expect(await domainOf(neri.tenantId, `https://${SHOP}`)).toEqual({
      status: 'VERIFIED',
      verification_method: 'SHOPIFY',
    });
  });

  it('is not added past the plan’s allowance, and the install still completes', async () => {
    const piena = await winery('piena', 'CANTINA');

    await db.execute(sql`
      insert into tenant_domains (tenant_id, origin, registrable_domain, status)
      values (${piena.tenantId}::uuid, 'https://www.piena.example', 'piena.example', 'VERIFIED')
    `);

    expect(outcomeOf(await callback(piena.owner, await started(piena, 'cantina-piena')))).toEqual({
      shopify: 'collegato',
      dominio: 'limite',
    });
    expect(await domainOf(piena.tenantId, 'https://cantina-piena.myshopify.com')).toBeUndefined();
  });
});

describe('the trial (P6-06b, Open Decision 10)', () => {
  it('starts when the install proves a winery’s first domain', async () => {
    const nuova = await winery('nuova', null);

    expect(outcomeOf(await callback(nuova.owner, await started(nuova, 'cantina-nuova')))).toEqual({
      shopify: 'collegato',
      dominio: 'verificato',
    });

    expect(await billingOf(nuova.tenantId)).toEqual({ status: 'TRIALING', trial_days: TRIAL.days });
    expect(await auditOf(nuova.tenantId, 'billing.trial_started')).toEqual([
      { target: `tenant:${nuova.tenantId}`, metadata: null },
    ]);
  });

  it('starts when the install verifies a domain the winery had pending', async () => {
    const attesa = await winery('attesa', null);
    const SHOP = 'cantina-attesa.myshopify.com';

    await db.execute(sql`
      insert into tenant_domains (tenant_id, origin, registrable_domain, status, verification_token)
      values (${attesa.tenantId}::uuid, ${`https://${SHOP}`}, ${SHOP}, 'PENDING', 'nonce')
    `);

    await callback(attesa.owner, await started(attesa, SHOP));

    expect((await billingOf(attesa.tenantId)).status).toBe('TRIALING');
  });

  it('does not start when the install proved no domain', async () => {
    /* At its allowance with a domain it never verified: nothing was proved, so nothing starts. */
    const ferma = await winery('ferma', null);

    await db.execute(sql`
      insert into tenant_domains (tenant_id, origin, registrable_domain, status, verification_token)
      values (${ferma.tenantId}::uuid, 'https://www.ferma.example', 'ferma.example', 'PENDING', 'nonce')
    `);

    expect(outcomeOf(await callback(ferma.owner, await started(ferma, 'cantina-ferma')))).toEqual({
      shopify: 'collegato',
      dominio: 'limite',
    });
    expect(await billingOf(ferma.tenantId)).toEqual({
      status: 'PENDING_VERIFICATION',
      trial_days: null,
    });
    expect(await auditOf(ferma.tenantId, 'billing.trial_started')).toEqual([]);
  });

  it('is had once: an uninstall and a second install start nothing', async () => {
    const torna = await winery('torna', null);
    const SHOP = 'cantina-torna.myshopify.com';

    await callback(torna.owner, await started(torna, SHOP));
    await db.execute(sql`
      update tenants set status = 'CANCELED', trial_ends_at = null where id = ${torna.tenantId}::uuid
    `);
    expect(await uninstall(SHOP)).toBe('uninstalled');
    await callback(torna.owner, await started(torna, SHOP));

    expect(await domainOf(torna.tenantId, `https://${SHOP}`)).toMatchObject({ status: 'VERIFIED' });
    expect((await billingOf(torna.tenantId)).status).toBe('CANCELED');
    expect(await auditOf(torna.tenantId, 'billing.trial_started')).toHaveLength(1);
  });
});

describe('the proof an uninstall withdraws (P6-06b, Open Decision 9)', () => {
  it('removes the origin the install proved, ends its sessions, and says why', async () => {
    const viola = await winery('viola');
    const SHOP = 'cantina-viola.myshopify.com';
    const origin = `https://${SHOP}`;

    await callback(viola.owner, await started(viola, SHOP));
    expect(await domainOf(viola.tenantId, origin)).toBeDefined();
    expect(await cutoffsOf(viola.tenantId, origin)).toBe(0);

    expect(await uninstall(SHOP)).toBe('uninstalled');

    expect(await domainOf(viola.tenantId, origin)).toBeUndefined();
    expect(await cutoffsOf(viola.tenantId, origin)).toBe(1);
    expect(await auditOf(viola.tenantId, 'domain.removed')).toEqual([
      { target: origin, metadata: { status: 'VERIFIED', kind: 'shopify-uninstalled' } },
    ]);
    expect(await auditOf(viola.tenantId, 'shopify.uninstalled')).toEqual([
      { target: SHOP, metadata: null },
    ]);
  });

  it('leaves the domains the seller proved another way', async () => {
    const blu = await winery('blu');
    const SHOP = 'cantina-blu.myshopify.com';

    await db.execute(sql`
      insert into tenant_domains (tenant_id, origin, registrable_domain, status, verification_method, verified_at)
      values (${blu.tenantId}::uuid, 'https://www.blu.example', 'blu.example', 'VERIFIED', 'DNS_TXT', now())
    `);
    await callback(blu.owner, await started(blu, SHOP));

    expect(await uninstall(SHOP)).toBe('uninstalled');

    expect(await domainOf(blu.tenantId, 'https://www.blu.example')).toEqual({
      status: 'VERIFIED',
      verification_method: 'DNS_TXT',
    });
    expect(await cutoffsOf(blu.tenantId, 'https://www.blu.example')).toBe(0);
    expect(await domainOf(blu.tenantId, `https://${SHOP}`)).toBeUndefined();
  });

  it('leaves the shop’s own origin when it stands on a proof that is not the install', async () => {
    const rosa = await winery('rosa');
    const SHOP = 'cantina-rosa.myshopify.com';
    const origin = `https://${SHOP}`;

    await db.execute(sql`
      insert into tenant_domains (tenant_id, origin, registrable_domain, status, verification_method, verified_at)
      values (${rosa.tenantId}::uuid, ${origin}, ${SHOP}, 'VERIFIED', 'WELL_KNOWN', now())
    `);
    await callback(rosa.owner, await started(rosa, SHOP));

    expect(await uninstall(SHOP)).toBe('uninstalled');

    expect(await domainOf(rosa.tenantId, origin)).toEqual({
      status: 'VERIFIED',
      verification_method: 'WELL_KNOWN',
    });
    expect(await cutoffsOf(rosa.tenantId, origin)).toBe(0);
    expect(await auditOf(rosa.tenantId, 'domain.removed')).toEqual([]);
    /* The install itself still ended. */
    expect(tokens.read(rosa.tenantId, SHOP)).toBeUndefined();
  });

  it('ends nothing on news of an uninstall older than the install', async () => {
    /* A redelivery that arrives after the seller put the app back (P6-06b). */
    const verde = await winery('verde-acqua');
    const SHOP = 'cantina-verde-acqua.myshopify.com';
    const origin = `https://${SHOP}`;

    await callback(verde.owner, await started(verde, SHOP));

    expect(await uninstall(SHOP, new Date(Date.now() - 60 * 60 * 1000))).toBe('stale');

    expect(tokens.read(verde.tenantId, SHOP)).toBeDefined();
    expect(await resolveTenantByShop(SHOP)).toBe(verde.tenantId);
    expect(await domainOf(verde.tenantId, origin)).toMatchObject({ status: 'VERIFIED' });
    expect(await cutoffsOf(verde.tenantId, origin)).toBe(0);
    expect(await auditOf(verde.tenantId, 'shopify.uninstalled')).toEqual([]);

    /* The one that is about this install does end it. */
    expect(await uninstall(SHOP, new Date(Date.now() + 60 * 1000))).toBe('uninstalled');
    expect(await domainOf(verde.tenantId, origin)).toBeUndefined();
  });

  it('gives the origin back on a reinstall', async () => {
    const oro = await winery('oro');
    const SHOP = 'cantina-oro.myshopify.com';

    await callback(oro.owner, await started(oro, SHOP));
    await uninstall(SHOP);

    expect(outcomeOf(await callback(oro.owner, await started(oro, SHOP)))).toEqual({
      shopify: 'collegato',
      dominio: 'verificato',
    });
    expect(await domainOf(oro.tenantId, `https://${SHOP}`)).toEqual({
      status: 'VERIFIED',
      verification_method: 'SHOPIFY',
    });
  });
});

describe('what the sommelier sold (P6-07)', () => {
  let rame: Winery;
  let altra: Winery;
  let barolo: string;
  const SHOP = 'cantina-rame.myshopify.com';
  const VARIANT = 45123456789;

  /** A visit as the widget leaves one: a conversation, and an event under the per-tab id. */
  const visit = async (who: Winery): Promise<{ visitorId: string; conversationId: string }> => {
    const visitorId = randomUUID();
    const [conversation] = [
      ...(await db.execute(sql`
        insert into conversations (tenant_id, session_id, origin, locale)
        values (${who.tenantId}::uuid, ${randomUUID()}, 'https://winery.example', 'it')
        returning id
      `)),
    ];
    const conversationId = String(conversation?.id);

    await db.execute(sql`
      insert into widget_events (tenant_id, session_id, conversation_id, type)
      values (${who.tenantId}::uuid, ${visitorId}, ${conversationId}::uuid, 'ADD_TO_CART')
    `);

    return { visitorId, conversationId };
  };

  /* Past any id another describe's rows could have used; small enough for JSON to carry whole. */
  let lineNumber = 7_000_000;

  const line = (visitorId: string | undefined, overrides: Record<string, unknown> = {}) => {
    lineNumber += 1;

    return {
      id: lineNumber,
      admin_graphql_api_id: `gid://shopify/LineItem/${String(lineNumber)}-${randomUUID()}`,
      variant_id: VARIANT,
      quantity: 1,
      price: '42.00',
      discount_allocations: [],
      properties: visitorId === undefined ? [] : [{ name: '_somm_session', value: visitorId }],
      ...overrides,
    };
  };

  /** An order as Shopify sends one — buyer and all. */
  const orderOf = (lines: readonly unknown[], overrides: Record<string, unknown> = {}) => {
    const orderId = `gid://shopify/Order/${randomUUID()}`;

    return {
      orderId,
      body: JSON.stringify({
        id: 5678901234567,
        admin_graphql_api_id: orderId,
        currency: 'EUR',
        created_at: '2026-10-05T10:15:30+02:00',
        email: 'giulia.bianchi@example.com',
        customer: { first_name: 'Giulia', last_name: 'Bianchi' },
        shipping_address: { address1: 'Via Roma 1', city: 'Alba' },
        line_items: lines,
        ...overrides,
      }),
    };
  };

  const created = (shop: string, body: string) =>
    runWithRequestContext({ requestId: randomUUID() }, () => port.orderCreated(shop, body));

  let refundNumber = 9_000_000;

  /** A refund as Shopify sends one: the order by number, each line by number, and a note. */
  const refunded = (
    shop: string,
    orderNumber: number,
    lines: readonly { readonly lineNumber: number; readonly quantity: number }[],
  ) => {
    const body = JSON.stringify({
      id: (refundNumber += 1),
      order_id: orderNumber,
      note: 'Bottiglia rotta — Giulia Bianchi',
      transactions: [{ amount: '42.00' }],
      refund_line_items: lines.map((one) => ({
        id: (refundNumber += 1),
        line_item_id: one.lineNumber,
        quantity: one.quantity,
        subtotal: '42.00',
      })),
    });

    return {
      body,
      deliver: () =>
        runWithRequestContext({ requestId: randomUUID() }, () => port.refundCreated(shop, body)),
    };
  };

  /** What an order is worth now: every entry for it, sales and refunds, summed. */
  const worth = async (orderId: string) => {
    const [row] = [
      ...(await db.execute(sql`
        select coalesce(sum(amount_cents), 0)::int as cents, coalesce(sum(quantity), 0)::int as units
        from attributions where order_id = ${orderId}
      `)),
    ];

    return { cents: Number(row?.cents), units: Number(row?.units) };
  };

  const sold = async (orderId: string) => [
    ...(await db.execute(sql`
        select tenant_id, shop, session_id, conversation_id, product_id, quantity, amount_cents, currency
        from attributions where order_id = ${orderId}
        order by amount_cents
      `)),
  ];

  beforeAll(async () => {
    rame = await winery('rame');
    altra = await winery('altra-rame');

    const [product] = [
      ...(await db.execute(sql`
        insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status, external_variant_id)
        values (${rame.tenantId}::uuid, 'SKU-BAROLO', 'Barolo', 'RED', 4200, 'EUR', 'IN_STOCK', ${String(VARIANT)})
        returning id
      `)),
    ];

    barolo = String(product?.id);
    await callback(rame.owner, await started(rame, SHOP));
  });

  it('attributes the wine we recommended, and not the two the shopper found themselves', async () => {
    const { visitorId, conversationId } = await visit(rame);
    const { orderId, body } = orderOf([
      line(undefined, { price: '18.00', quantity: 2 }),
      line(visitorId, { quantity: 2, discount_allocations: [{ amount: '8.40' }] }),
      line(undefined, { price: '65.00' }),
    ]);

    expect(await created(SHOP, body)).toBe('attributed');

    expect(await sold(orderId)).toEqual([
      {
        tenant_id: rame.tenantId,
        shop: SHOP,
        session_id: visitorId,
        conversation_id: conversationId,
        product_id: barolo,
        quantity: 2,
        amount_cents: 7560,
        currency: 'EUR',
      },
    ]);
  });

  it('counts a redelivered order once', async () => {
    const { visitorId } = await visit(rame);
    const { orderId, body } = orderOf([line(visitorId)]);

    expect(await created(SHOP, body)).toBe('attributed');
    expect(await created(SHOP, body)).toBe('nothing');
    expect(await sold(orderId)).toHaveLength(1);
  });

  it('attributes nothing for an order the widget had no part in', async () => {
    const { orderId, body } = orderOf([line(undefined), line(undefined)]);

    expect(await created(SHOP, body)).toBe('nothing');
    expect(await sold(orderId)).toEqual([]);
  });

  it('attributes two visits in one order separately', async () => {
    const [one, two] = [await visit(rame), await visit(rame)];
    const { orderId, body } = orderOf([
      line(one.visitorId, { price: '10.00' }),
      line(two.visitorId, { price: '20.00' }),
    ]);

    await created(SHOP, body);

    expect(
      (await sold(orderId)).map((row) => [row.session_id, row.conversation_id, row.amount_cents]),
    ).toEqual([
      [one.visitorId, one.conversationId, 1000],
      [two.visitorId, two.conversationId, 2000],
    ]);
  });

  it('does not believe a visit nobody had, or one that was another winery’s', async () => {
    const theirs = await visit(altra);
    const { orderId, body } = orderOf([line(randomUUID()), line(theirs.visitorId)]);

    expect(await created(SHOP, body)).toBe('nothing');
    expect(await sold(orderId)).toEqual([]);
  });

  it('counts nothing for a test order', async () => {
    const { visitorId } = await visit(rame);
    const { orderId, body } = orderOf([line(visitorId)], { test: true });

    expect(await created(SHOP, body)).toBe('nothing');
    expect(await sold(orderId)).toEqual([]);
  });

  it('keeps nothing about the buyer, and has nowhere it could', async () => {
    const { visitorId } = await visit(rame);
    const { orderId, body } = orderOf([line(visitorId)]);

    await created(SHOP, body);

    const [row] = [
      ...(await db.execute(sql`
        select to_jsonb(a)::text as everything from attributions a where order_id = ${orderId}
      `)),
    ];

    for (const personal of ['giulia', 'Giulia', 'Bianchi', 'Via Roma', 'Alba']) {
      expect(String(row?.everything)).not.toContain(personal);
    }

    const columns = [
      ...(await db.execute(sql`
        select column_name from information_schema.columns where table_name = 'attributions'
      `)),
    ].map((column) => String(column.column_name));

    expect(columns.sort()).toEqual([
      'amount_cents',
      'conversation_id',
      'created_at',
      'currency',
      'id',
      'line_item_id',
      'order_id',
      'ordered_at',
      'product_id',
      'quantity',
      'refund_line_id',
      'session_id',
      'shop',
      'tenant_id',
    ]);
  });

  it('says so for a body it cannot read, and records nothing', async () => {
    expect(await created(SHOP, '{"id": 1')).toBe('unreadable');
  });

  describe('and a refund takes back (P6-08)', () => {
    /** An order of ours as Shopify numbers one, so a refund can name it the way Shopify does. */
    const soldOrder = async (lines: readonly Record<string, unknown>[]) => {
      const orderNumber = (lineNumber += 1);
      const orderId = `gid://shopify/Order/${String(orderNumber)}`;

      await created(
        SHOP,
        JSON.stringify({
          id: orderNumber,
          admin_graphql_api_id: orderId,
          currency: 'EUR',
          created_at: '2026-10-05T10:15:30+02:00',
          line_items: lines,
        }),
      );

      return { orderNumber, orderId };
    };

    /** A line of ours whose GraphQL id is the one Shopify would give its number. */
    const ours = (visitorId: string, overrides: Record<string, unknown> = {}) => {
      const numbered = line(visitorId, overrides);

      return { ...numbered, admin_graphql_api_id: `gid://shopify/LineItem/${String(numbered.id)}` };
    };

    it('reduces what was sold by the units that came back', async () => {
      const { visitorId } = await visit(rame);
      const sold_ = ours(visitorId, { quantity: 4, price: '25.00' });
      const { orderNumber, orderId } = await soldOrder([sold_]);

      expect(await worth(orderId)).toEqual({ cents: 10000, units: 4 });

      const refund = refunded(SHOP, orderNumber, [{ lineNumber: sold_.id, quantity: 1 }]);

      expect(await refund.deliver()).toBe('reduced');
      expect(await worth(orderId)).toEqual({ cents: 7500, units: 3 });
    });

    it('takes a redelivered refund off once', async () => {
      const { visitorId } = await visit(rame);
      const sold_ = ours(visitorId, { quantity: 2 });
      const { orderNumber, orderId } = await soldOrder([sold_]);
      const refund = refunded(SHOP, orderNumber, [{ lineNumber: sold_.id, quantity: 1 }]);

      expect(await refund.deliver()).toBe('reduced');
      expect(await refund.deliver()).toBe('nothing');
      expect(await worth(orderId)).toEqual({ cents: 4200, units: 1 });
    });

    it('reduces only ours, when the refund also returns what the shopper found themselves', async () => {
      const { visitorId } = await visit(rame);
      const found = line(undefined, { price: '65.00' });
      const sold_ = ours(visitorId);
      const { orderNumber, orderId } = await soldOrder([found, sold_]);

      const refund = refunded(SHOP, orderNumber, [
        { lineNumber: found.id, quantity: 1 },
        { lineNumber: sold_.id, quantity: 1 },
      ]);

      expect(await refund.deliver()).toBe('reduced');
      expect(await worth(orderId)).toEqual({ cents: 0, units: 0 });
      expect(await sold(orderId)).toHaveLength(2);
    });

    it('reduces nothing for an order the sommelier had no part in', async () => {
      const found = line(undefined);
      const { orderNumber, orderId } = await soldOrder([found]);

      expect(
        await refunded(SHOP, orderNumber, [{ lineNumber: found.id, quantity: 1 }]).deliver(),
      ).toBe('nothing');
      expect(await sold(orderId)).toEqual([]);
    });

    it('keeps nothing of the refund’s note', async () => {
      const { visitorId } = await visit(rame);
      const sold_ = ours(visitorId);
      const { orderNumber, orderId } = await soldOrder([sold_]);

      await refunded(SHOP, orderNumber, [{ lineNumber: sold_.id, quantity: 1 }]).deliver();

      const rows = [
        ...(await db.execute(sql`
          select to_jsonb(a)::text as everything from attributions a where order_id = ${orderId}
        `)),
      ];

      expect(rows).toHaveLength(2);
      for (const row of rows) {
        expect(String(row.everything)).not.toContain('Giulia');
        expect(String(row.everything)).not.toContain('rotta');
      }
    });

    it('says so for a body it cannot read', async () => {
      expect(
        await runWithRequestContext({ requestId: randomUUID() }, () =>
          port.refundCreated(SHOP, '{"order_id": 1'),
        ),
      ).toBe('unreadable');
    });
  });

  it('records nothing for a shop that removed the app', async () => {
    const via = await winery('via');
    const GONE = 'cantina-via.myshopify.com';

    await callback(via.owner, await started(via, GONE));

    const { visitorId } = await visit(via);
    const { orderId, body } = orderOf([line(visitorId)]);

    await uninstall(GONE);

    expect(await created(GONE, body)).toBe('unknown');
    expect(await sold(orderId)).toEqual([]);
  });
});

describe('stock the shop reports (P6-11)', () => {
  let grigio: Winery;
  const SHOP = 'cantina-grigio.myshopify.com';
  let variantNumber = 46_000_000_000;

  const addWine = async (who: Winery) => {
    const variantId = (variantNumber += 1);
    const [row] = [
      ...(await db.execute(sql`
        insert into products (
          tenant_id, sku, name, wine_type, price_cents, currency, stock_status, stock_qty,
          external_variant_id, content_hash, embedding_state
        )
        values (${who.tenantId}::uuid, ${`SKU-${String(variantId)}`}, 'Barolo', 'RED', 4200, 'EUR',
                'IN_STOCK', 12, ${String(variantId)}, 'hash-of-what-the-model-read', 'INDEXED')
        returning id
      `)),
    ];

    return { id: String(row?.id), variantId };
  };

  const wine = async (id: string) =>
    [
      ...(await db.execute(sql`
        select stock_status, stock_qty, content_hash, embedding_state
        from products where id = ${id}::uuid
      `)),
    ][0];

  const updated = (shop: string, variants: unknown[], at = '2026-10-05T10:15:30+02:00') =>
    runWithRequestContext({ requestId: randomUUID() }, () =>
      port.productUpdated(shop, JSON.stringify({ title: 'Barolo', updated_at: at, variants })),
    );

  const outboxOf = async (tenantId: string): Promise<number> =>
    Number(
      [
        ...(await db.execute(
          sql`select count(*)::int as n from outbox where tenant_id = ${tenantId}::uuid`,
        )),
      ][0]?.n,
    );

  beforeAll(async () => {
    grigio = await winery('grigio');
    await callback(grigio.owner, await started(grigio, SHOP));
  });

  it('sells a wine out the moment the shop says its last bottle went', async () => {
    const barolo = await addWine(grigio);

    expect(
      await updated(SHOP, [
        { id: barolo.variantId, inventory_quantity: 0, inventory_management: 'shopify' },
      ]),
    ).toEqual({ outcome: 'synced' });
    expect(await wine(barolo.id)).toMatchObject({ stock_status: 'OUT_OF_STOCK', stock_qty: 0 });
  });

  it('costs no embedding: no outbox row, and nothing the model read is touched', async () => {
    const barolo = await addWine(grigio);
    const before = await outboxOf(grigio.tenantId);

    await updated(SHOP, [
      { id: barolo.variantId, inventory_quantity: 3, inventory_management: 'shopify' },
    ]);

    expect(await outboxOf(grigio.tenantId)).toBe(before);
    expect(await wine(barolo.id)).toEqual({
      stock_status: 'IN_STOCK',
      stock_qty: 3,
      content_hash: 'hash-of-what-the-model-read',
      embedding_state: 'INDEXED',
    });
  });

  it('keeps a wine the shop does not count in stock', async () => {
    const barolo = await addWine(grigio);

    await updated(SHOP, [
      { id: barolo.variantId, inventory_quantity: 0, inventory_management: null },
    ]);

    expect(await wine(barolo.id)).toMatchObject({ stock_status: 'IN_STOCK', stock_qty: null });
  });

  it('does nothing with a redelivery, or with news older than what it has', async () => {
    const barolo = await addWine(grigio);
    const soldOut = [
      { id: barolo.variantId, inventory_quantity: 0, inventory_management: 'shopify' },
    ];

    expect(await updated(SHOP, soldOut, '2026-10-05T10:20:00+02:00')).toEqual({
      outcome: 'synced',
    });
    expect(await updated(SHOP, soldOut, '2026-10-05T10:20:00+02:00')).toEqual({
      outcome: 'nothing',
    });
    expect(
      await updated(
        SHOP,
        [{ id: barolo.variantId, inventory_quantity: 6, inventory_management: 'shopify' }],
        '2026-10-05T10:19:00+02:00',
      ),
    ).toEqual({ outcome: 'nothing' });
    expect(await wine(barolo.id)).toMatchObject({ stock_status: 'OUT_OF_STOCK', stock_qty: 0 });
  });

  it('ignores a variant the catalogue does not hold, without an error', async () => {
    expect(
      await updated(SHOP, [
        { id: 99_999_999_999, inventory_quantity: 0, inventory_management: 'shopify' },
      ]),
    ).toEqual({ outcome: 'nothing' });
  });

  it('moves only this winery’s wine, whatever variant the shop names', async () => {
    const altra = await winery('altra-grigio');
    const theirs = await addWine(altra);

    expect(
      await updated(SHOP, [
        { id: theirs.variantId, inventory_quantity: 0, inventory_management: 'shopify' },
      ]),
    ).toEqual({ outcome: 'nothing' });
    expect(await wine(theirs.id)).toMatchObject({ stock_status: 'IN_STOCK', stock_qty: 12 });
  });

  it('moves nothing for a shop that removed the app', async () => {
    const nero = await winery('nero');
    const GONE = 'cantina-nero.myshopify.com';

    await callback(nero.owner, await started(nero, GONE));

    const barolo = await addWine(nero);

    await uninstall(GONE);

    expect(
      await updated(GONE, [
        { id: barolo.variantId, inventory_quantity: 0, inventory_management: 'shopify' },
      ]),
    ).toEqual({ outcome: 'unknown' });
    expect(await wine(barolo.id)).toMatchObject({ stock_status: 'IN_STOCK', stock_qty: 12 });
  });
});

describe('Shopify’s privacy requests (P6-09b)', () => {
  let numbered = 8_000_000;
  const next = (): number => (numbered += 1);

  /** A winery with a connected shop and one sale of ours in each of `orders` orders. */
  const withSales = async (slug: string, orders: number) => {
    const who = await winery(slug);
    const shop = `cantina-${slug}.myshopify.com`;

    await callback(who.owner, await started(who, shop));

    const sold: { number: number; orderId: string; conversationId: string }[] = [];

    for (let index = 0; index < orders; index += 1) {
      const visitorId = randomUUID();
      const [conversation] = [
        ...(await db.execute(sql`
          insert into conversations (tenant_id, session_id, origin, locale)
          values (${who.tenantId}::uuid, ${randomUUID()}, 'https://winery.example', 'it')
          returning id
        `)),
      ];
      const conversationId = String(conversation?.id);

      await db.execute(sql`
        insert into widget_events (tenant_id, session_id, conversation_id, type)
        values (${who.tenantId}::uuid, ${visitorId}, ${conversationId}::uuid, 'ADD_TO_CART')
      `);

      const number = next();
      const orderId = `gid://shopify/Order/${String(number)}`;
      const line = next();

      await runWithRequestContext({ requestId: randomUUID() }, () =>
        port.orderCreated(
          shop,
          JSON.stringify({
            id: number,
            admin_graphql_api_id: orderId,
            currency: 'EUR',
            line_items: [
              {
                id: line,
                admin_graphql_api_id: `gid://shopify/LineItem/${String(line)}`,
                quantity: 1,
                price: '42.00',
                properties: [{ name: '_somm_session', value: visitorId }],
              },
            ],
          }),
        ),
      );

      sold.push({ number, orderId, conversationId });
    }

    return { who, shop, sold };
  };

  const held = async (tenantId: string): Promise<string[]> =>
    [
      ...(await db.execute(sql`
        select order_id from attributions where tenant_id = ${tenantId}::uuid order by order_id
      `)),
    ].map((row) => String(row.order_id));

  const customer = { id: 191167, email: 'giulia.bianchi@example.com', phone: '+39 333 0000000' };

  const ask = (
    method: 'customerRedact' | 'customerDataRequest' | 'shopRedact',
    shop: string,
    body: Record<string, unknown>,
  ) =>
    runWithRequestContext({ requestId: randomUUID() }, () =>
      port[method](shop, JSON.stringify({ shop_domain: shop, customer, ...body })),
    );

  it('erases what was recorded for a customer’s orders, and only those', async () => {
    const { who, shop, sold } = await withSales('cliente', 3);
    const [first, second, third] = sold;

    expect(
      await ask('customerRedact', shop, { orders_to_redact: [first?.number, second?.number] }),
    ).toBe('erased');

    expect(await held(who.tenantId)).toEqual([third?.orderId]);
    expect(await auditOf(who.tenantId, 'shopify.customer_redacted')).toEqual([
      { target: shop, metadata: { count: 2 } },
    ]);
  });

  it('leaves the conversation, which is nobody’s again once the order is gone', async () => {
    const { shop, sold } = await withSales('conversazione', 1);
    const [only] = sold;

    await ask('customerRedact', shop, { orders_to_redact: [only?.number] });

    const [conversation] = [
      ...(await db.execute(sql`
        select id from conversations where id = ${only?.conversationId ?? ''}::uuid
      `)),
    ];

    expect(conversation).toBeDefined();
  });

  it('erases a refund with its sale, so nothing negative is left behind', async () => {
    const { who, shop, sold } = await withSales('reso', 1);
    const [only] = sold;
    const [line] = [
      ...(await db.execute(sql`
        select line_item_id from attributions where order_id = ${only?.orderId ?? ''}
      `)),
    ];

    await runWithRequestContext({ requestId: randomUUID() }, () =>
      port.refundCreated(
        shop,
        JSON.stringify({
          order_id: only?.number,
          refund_line_items: [
            {
              id: next(),
              line_item_id: Number(String(line?.line_item_id).replace(/\D+/gu, '')),
              quantity: 1,
            },
          ],
        }),
      ),
    );
    expect(await held(who.tenantId)).toHaveLength(2);

    expect(await ask('customerRedact', shop, { orders_to_redact: [only?.number] })).toBe('erased');
    expect(await held(who.tenantId)).toEqual([]);
  });

  it('records nothing for a customer the sommelier never sold to', async () => {
    const { who, shop } = await withSales('estraneo', 1);

    expect(await ask('customerRedact', shop, { orders_to_redact: [next()] })).toBe('nothing');
    expect(await held(who.tenantId)).toHaveLength(1);
    expect(await auditOf(who.tenantId, 'shopify.customer_redacted')).toEqual([]);
  });

  it('says a data request has something to answer with, and records it under Shopify’s id', async () => {
    const { who, shop, sold } = await withSales('richiesta', 2);
    const [first] = sold;

    expect(
      await ask('customerDataRequest', shop, {
        orders_requested: [first?.number],
        data_request: { id: 9999 },
      }),
    ).toBe('held');

    /* Counted, not erased. */
    expect(await held(who.tenantId)).toHaveLength(2);
    expect(await auditOf(who.tenantId, 'shopify.data_requested')).toEqual([
      { target: 'data_request:9999', metadata: { count: 1 } },
    ]);
  });

  it('says a data request has nothing to answer with, and records nothing', async () => {
    const { who, shop } = await withSales('niente', 1);

    expect(
      await ask('customerDataRequest', shop, {
        orders_requested: [next()],
        data_request: { id: 1 },
      }),
    ).toBe('nothing');
    expect(await auditOf(who.tenantId, 'shopify.data_requested')).toEqual([]);
  });

  it('erases everything recorded for a shop that removed the app, 48 hours on', async () => {
    const { who, shop } = await withSales('chiuso', 2);

    await uninstall(shop);
    /* Uninstalled: the ordinary lookup no longer finds it, and the request still has to. */
    expect(await resolveTenantByShop(shop)).toBeUndefined();

    expect(await ask('shopRedact', shop, { shop_id: 954889 })).toBe('erased');
    expect(await held(who.tenantId)).toEqual([]);
    expect(await auditOf(who.tenantId, 'shopify.shop_redacted')).toEqual([
      { target: shop, metadata: { count: 2 } },
    ]);
    /* And once more is nothing: Shopify redelivers. */
    expect(await ask('shopRedact', shop, { shop_id: 954889 })).toBe('nothing');
  });

  it('still answers a customer’s request for a shop that has removed the app', async () => {
    const { who, shop, sold } = await withSales('tardi', 1);

    await uninstall(shop);

    expect(await ask('customerRedact', shop, { orders_to_redact: [sold[0]?.number] })).toBe(
      'erased',
    );
    expect(await held(who.tenantId)).toEqual([]);
  });

  it('erases only the shop named, and nothing of another winery’s', async () => {
    const ours = await withSales('nostro', 1);
    const theirs = await withSales('loro', 1);

    await uninstall(ours.shop);
    await ask('shopRedact', ours.shop, {});

    expect(await held(ours.who.tenantId)).toEqual([]);
    expect(await held(theirs.who.tenantId)).toHaveLength(1);

    /* Nor can one winery's shop reach another's orders, whatever numbers it sends. */
    expect(
      await ask('customerRedact', ours.shop, { orders_to_redact: [theirs.sold[0]?.number] }),
    ).toBe('nothing');
    expect(await held(theirs.who.tenantId)).toHaveLength(1);
  });

  it('does not act on a header naming another shop than the signed body', async () => {
    const victim = await withSales('vittima', 1);
    const other = await withSales('mittente', 1);

    expect(
      await runWithRequestContext({ requestId: randomUUID() }, () =>
        port.shopRedact(victim.shop, JSON.stringify({ shop_domain: other.shop })),
      ),
    ).toBe('unknown');
    expect(await held(victim.who.tenantId)).toHaveLength(1);
    expect(await held(other.who.tenantId)).toHaveLength(1);
  });

  it('keeps nothing of the customer who asked', async () => {
    const { who, shop, sold } = await withSales('riservato', 1);

    await ask('customerDataRequest', shop, {
      orders_requested: [sold[0]?.number],
      data_request: { id: 7 },
    });

    const rows = [
      ...(await db.execute(sql`
        select to_jsonb(a)::text as everything from audit_log a
        where tenant_id = ${who.tenantId}::uuid
      `)),
    ];

    for (const row of rows) {
      expect(String(row.everything)).not.toContain('giulia');
      expect(String(row.everything)).not.toContain('191167');
      expect(String(row.everything)).not.toContain('333');
    }
  });
});

describe('the uninstall', () => {
  it('deletes the token, marks the shop, and stops it resolving', async () => {
    const gialli = await winery('gialli');
    const SHOP = 'cantina-gialli.myshopify.com';

    await callback(gialli.owner, await started(gialli, SHOP));
    expect(tokens.read(gialli.tenantId, SHOP)).toBeDefined();

    expect(
      await runWithRequestContext({ requestId: randomUUID() }, () => port.uninstalled(SHOP)),
    ).toBe('uninstalled');

    expect(tokens.read(gialli.tenantId, SHOP)).toBeUndefined();
    expect(await resolveTenantByShop(SHOP)).toBeUndefined();
    expect((await port.status(gialli.tenantId)).shop?.uninstalledAt).not.toBeNull();
    expect(
      await runWithRequestContext({ requestId: randomUUID() }, () => port.uninstalled(SHOP)),
    ).toBe('unknown');
  });
});
