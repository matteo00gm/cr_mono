import process from 'node:process';
import { createHmac, randomUUID } from 'node:crypto';

import { runWithRequestContext } from '@catalogorosso/core';
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
  plan: 'CANTINA' | 'ECOMMERCE' = 'ECOMMERCE',
): Promise<Winery> => {
  const tenantId = randomUUID();
  const owner = `owner_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  await db.execute(sql`
    insert into tenants (id, name, slug, status, plan, locale, stripe_subscription_id)
    values (${tenantId}::uuid, ${slug}, ${`${slug}-${tenantId}`}, 'ACTIVE', ${plan}, 'it',
            'sub_' || gen_random_uuid())
  `);
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

  it('audits the install under the winery', async () => {
    const [row] = [
      ...(await db.execute(sql`
        select action, target from audit_log
        where tenant_id = ${rossi.tenantId}::uuid and action = 'shopify.installed'
      `)),
    ];

    expect(row).toEqual({ action: 'shopify.installed', target: SHOP });
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
