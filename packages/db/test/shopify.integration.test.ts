import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  markShopifyUninstalled,
  NestedShopifyScopeError,
  readShopifyInstallation,
  recordShopifyInstall,
  resolveTenantByShop,
  spendShopifyState,
  startShopifyInstall,
} from '../src/shopify.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { clearTenant, createAuthUser, createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The Shopify install against real Postgres (P6-06, ADR 0031): a state spent
 * once and only by its member, one shop per winery, and a shop resolved to
 * its winery in a scope that can see one row and write nothing.
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const READ_ONLY_TRANSACTION = '25006';
const INSUFFICIENT_PRIVILEGE = '42501';
const CHECK_VIOLATION = '23514';

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;
let owner: string;
let stranger: string;

const IN_TEN_MINUTES = () => new Date(Date.now() + 10 * 60 * 1000);

const started = async (shop: string, userId = owner, expiresAt = IN_TEN_MINUTES()) => {
  const nonceHash = randomUUID().replaceAll('-', '').repeat(2);

  await withTenant(
    tenantId,
    (tx) => startShopifyInstall(tx, { userId, shop, nonceHash, expiresAt }),
    db,
  );

  return nonceHash;
};

beforeAll(async () => {
  const container_ = await startPostgres();
  container = container_.container;
  client = createDbClient(container_.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  owner = await createAuthUser(db, 'owner');
  stranger = await createAuthUser(db, 'stranger');
  otherTenantId = await createTenant(db, 'altra-shopify');
  tenantId = await createTenant(db, 'shopify');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  await clearTenant(db);
});

describe('the state', () => {
  it('is spent once, by the member who started it, naming the winery and shop', async () => {
    const nonceHash = await started('cantina-rossi.myshopify.com');

    expect(await spendShopifyState(owner, nonceHash, new Date(), db)).toEqual({
      tenantId,
      shop: 'cantina-rossi.myshopify.com',
      expired: false,
    });
    expect(await spendShopifyState(owner, nonceHash, new Date(), db)).toBeUndefined();
  });

  it('does not exist for another member', async () => {
    const nonceHash = await started('cantina-rossi.myshopify.com');

    expect(await spendShopifyState(stranger, nonceHash, new Date(), db)).toBeUndefined();
    /* And it is still there for its own member: a stranger's attempt spends nothing. */
    expect(await spendShopifyState(owner, nonceHash, new Date(), db)).toMatchObject({ tenantId });
  });

  it('is spent when it has lapsed too, and says so', async () => {
    const nonceHash = await started('cantina-rossi.myshopify.com', owner, new Date(Date.now() - 1));

    expect(await spendShopifyState(owner, nonceHash, new Date(), db)).toMatchObject({
      expired: true,
    });
    expect(await spendShopifyState(owner, nonceHash, new Date(), db)).toBeUndefined();
  });

  it('is invisible to another winery', async () => {
    const nonceHash = await started('cantina-rossi.myshopify.com');

    await useTenant(db, otherTenantId);
    const seen = [
      ...(await db.execute(
        sql`select 1 from shopify_oauth_states where nonce_hash = ${nonceHash}`,
      )),
    ];

    expect(seen).toHaveLength(0);
  });

  it('cannot be written by the member scope naming any winery', async () => {
    await clearTenant(db);
    const error = await db
      .transaction(async (tx) => {
        await tx.execute(sql`select set_config('app.user_id', ${owner}, true)`);
        await tx.execute(sql`
          insert into shopify_oauth_states (tenant_id, user_id, shop, nonce_hash, expires_at)
          values (${otherTenantId}::uuid, ${owner}, 'x.myshopify.com', ${randomUUID()}, now())
        `);
      })
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('the installation', () => {
  it('is recorded for the winery, and read back', async () => {
    const shop = `rossi-${randomUUID().slice(0, 8)}.myshopify.com`;

    expect(
      await withTenant(
        tenantId,
        (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_products,read_orders' }),
        db,
      ),
    ).toBe('installed');
    expect(await withTenant(tenantId, (tx) => readShopifyInstallation(tx), db)).toMatchObject({
      shop,
      scopes: 'read_products,read_orders',
      uninstalledAt: null,
    });
  });

  it('refuses a shop another winery holds, and leaves it theirs', async () => {
    const shop = `contesa-${randomUUID().slice(0, 8)}.myshopify.com`;

    await withTenant(
      otherTenantId,
      (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_products' }),
      db,
    );

    expect(
      await withTenant(
        tenantId,
        (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_orders' }),
        db,
      ),
    ).toBe('shop_taken');
    expect(await resolveTenantByShop(shop, db)).toBe(otherTenantId);
  });

  it('comes back as the same row on a reinstall, uninstalled no longer', async () => {
    const shop = `ritorno-${randomUUID().slice(0, 8)}.myshopify.com`;

    await withTenant(
      tenantId,
      (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_products' }),
      db,
    );
    expect(await withTenant(tenantId, (tx) => markShopifyUninstalled(tx, shop), db)).toBe(true);
    expect(await withTenant(tenantId, (tx) => markShopifyUninstalled(tx, shop), db)).toBe(false);

    expect(
      await withTenant(
        tenantId,
        (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_orders' }),
        db,
      ),
    ).toBe('installed');
    expect(await withTenant(tenantId, (tx) => readShopifyInstallation(tx), db)).toMatchObject({
      shop,
      scopes: 'read_orders',
      uninstalledAt: null,
    });
  });

  it('holds only a myshopify.com name', async () => {
    const error = await withTenant(
      tenantId,
      (tx) => recordShopifyInstall(tx, { shop: 'www.cantina.example', scopes: 'x' }),
      db,
    ).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(CHECK_VIOLATION);
  });

  it('uninstalls the shop it is told, and leaves the winery’s other shop installed', async () => {
    const first = `prima-${randomUUID().slice(0, 8)}.myshopify.com`;
    const second = `seconda-${randomUUID().slice(0, 8)}.myshopify.com`;

    for (const shop of [first, second]) {
      await withTenant(
        tenantId,
        (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_orders' }),
        db,
      );
    }

    await withTenant(tenantId, (tx) => markShopifyUninstalled(tx, first), db);

    expect(await resolveTenantByShop(first, db)).toBeUndefined();
    expect(await resolveTenantByShop(second, db)).toBe(tenantId);
  });

  it('does not uninstall another winery’s shop, whatever it is told', async () => {
    const theirs = `altrui-${randomUUID().slice(0, 8)}.myshopify.com`;

    await withTenant(
      otherTenantId,
      (tx) => recordShopifyInstall(tx, { shop: theirs, scopes: 'read_orders' }),
      db,
    );

    expect(await withTenant(tenantId, (tx) => markShopifyUninstalled(tx, theirs), db)).toBe(false);
    expect(await resolveTenantByShop(theirs, db)).toBe(otherTenantId);
  });

  it('cannot be deleted by the runtime role: an uninstall is recorded, not erased', async () => {
    const error = await withTenant(
      tenantId,
      (tx) => tx.execute(sql`delete from shopify_installations`),
      db,
    ).catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(INSUFFICIENT_PRIVILEGE);
  });
});

describe('resolveTenantByShop', () => {
  it('finds the winery for an installed shop, and nothing for one uninstalled', async () => {
    const shop = `trovata-${randomUUID().slice(0, 8)}.myshopify.com`;

    await withTenant(
      tenantId,
      (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_orders' }),
      db,
    );
    expect(await resolveTenantByShop(shop, db)).toBe(tenantId);

    await withTenant(tenantId, (tx) => markShopifyUninstalled(tx, shop), db);
    expect(await resolveTenantByShop(shop, db)).toBeUndefined();
  });

  it('finds nothing for a shop nobody holds', async () => {
    expect(await resolveTenantByShop('nessuno.myshopify.com', db)).toBeUndefined();
  });

  it('can see one installation and nothing else, and write nothing', async () => {
    const shop = `vista-${randomUUID().slice(0, 8)}.myshopify.com`;

    await withTenant(
      tenantId,
      (tx) => recordShopifyInstall(tx, { shop, scopes: 'read_orders' }),
      db,
    );
    await clearTenant(db);

    /* The flag as the scope sets it, in a READ ONLY transaction, asked for everything. */
    const seen = await db.transaction(
      async (tx) => {
        await tx.execute(sql`select set_config('app.shopify_shop', ${shop}, true)`);

        return {
          installations: [...(await tx.execute(sql`select shop from shopify_installations`))]
            .length,
          tenants: [...(await tx.execute(sql`select id from tenants`))].length,
          states: [...(await tx.execute(sql`select id from shopify_oauth_states`))].length,
        };
      },
      { accessMode: 'read only' },
    );

    expect(seen).toEqual({ installations: 1, tenants: 0, states: 0 });

    const write = await db
      .transaction(
        async (tx) => {
          await tx.execute(sql`select set_config('app.shopify_shop', ${shop}, true)`);
          await tx.execute(sql`update shopify_installations set scopes = 'x' where shop = ${shop}`);
        },
        { accessMode: 'read only' },
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(write)).toBe(READ_ONLY_TRANSACTION);
  });

  it('refuses to open inside a tenant scope, where its branch would widen the tenant’s', async () => {
    await expect(
      withTenant(tenantId, () => resolveTenantByShop('x.myshopify.com', db), db),
    ).rejects.toBeInstanceOf(NestedShopifyScopeError);
  });
});
