import { PgDialect } from 'drizzle-orm/pg-core';
import type { SQL } from 'drizzle-orm';
import { describe, expect, it, vi } from 'vitest';

import type { Database } from '../src/client.js';
import {
  markShopifyUninstalled,
  readShopifyInstallation,
  recordShopifyInstall,
  resolveTenantByShop,
  SHOPIFY_SHOP_GUC,
  spendShopifyState,
  startShopifyInstall,
} from '../src/shopify.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { text } from './support/sql-text.js';

/**
 * The Shopify install's statements, without a database (P6-06). What the
 * scopes admit and refuse is real Postgres, in `shopify.integration.test.ts`;
 * what is held here is what each statement says, what it binds, and how an
 * answer is read back.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const SHOP = 'cantina-rossi.myshopify.com';

/** A transaction whose `execute` answers each call with the next set of rows. */
const fakeTx = (...answers: unknown[][]) => {
  const execute = vi.fn<(statement: SQL) => Promise<unknown[]>>(() =>
    Promise.resolve(answers.shift() ?? []),
  );
  return { execute, tx: { execute } as unknown as DbTransaction };
};

/** A database whose transactions run on the fake, recording how each was opened. */
const fakeDb = (...answers: unknown[][]) => {
  const fake = fakeTx(...answers);
  const opened: unknown[] = [];
  const db = {
    transaction: (fn: (tx: DbTransaction) => Promise<unknown>, config?: unknown) => {
      opened.push(config);
      return fn(fake.tx);
    },
  } as unknown as Database;

  return { ...fake, db, opened };
};

const said = (fake: { execute: ReturnType<typeof fakeTx>['execute'] }, call = 0): string =>
  text(fake.execute.mock.calls[call]?.[0]);

const bound = (fake: { execute: ReturnType<typeof fakeTx>['execute'] }, call = 0): unknown[] => {
  const statement = fake.execute.mock.calls[call]?.[0];
  if (statement === undefined) throw new Error('no statement');
  return new PgDialect().sqlToQuery(statement).params;
};

describe('startShopifyInstall', () => {
  it('records the state in the scope’s winery, with the hash and never the nonce', async () => {
    const fake = fakeTx();
    const expiresAt = new Date('2026-10-04T10:10:00.000Z');

    await startShopifyInstall(fake.tx, { userId: 'u-1', shop: SHOP, nonceHash: 'h-1', expiresAt });

    expect(said(fake)).toContain("nullif(current_setting('app.tenant_id', true), '')::uuid");
    expect(bound(fake)).toEqual(['u-1', SHOP, 'h-1', expiresAt.toISOString()]);
  });
});

describe('spendShopifyState', () => {
  it('deletes the member’s own state in the member’s scope, and reads back the winery', async () => {
    const fake = fakeDb(
      [],
      [{ tenant_id: TENANT, shop: SHOP, expires_at: '2026-10-04 10:10:00+00' }],
    );

    expect(
      await spendShopifyState('u-1', 'h-1', new Date('2026-10-04T10:00:00.000Z'), fake.db),
    ).toEqual({ tenantId: TENANT, shop: SHOP, expired: false });
    expect(said(fake, 0)).toContain("set_config('app.user_id'");
    expect(said(fake, 1)).toContain('delete from shopify_oauth_states');
    expect(bound(fake, 1)).toEqual(['h-1', 'u-1']);
  });

  it('reads a state past its time as expired — and spent all the same', async () => {
    const fake = fakeDb(
      [],
      [{ tenant_id: TENANT, shop: SHOP, expires_at: '2026-10-04 10:10:00+00' }],
    );

    expect(
      await spendShopifyState('u-1', 'h-1', new Date('2026-10-04T10:10:00.000Z'), fake.db),
    ).toMatchObject({ expired: true });
  });

  it('is nothing when no state matched', async () => {
    expect(await spendShopifyState('u-1', 'h-1', new Date(), fakeDb([], []).db)).toBeUndefined();
  });
});

describe('recordShopifyInstall', () => {
  it('brings back the winery’s own row on a reinstall, and asks nothing more', async () => {
    const fake = fakeTx([{ id: 'i-1' }]);

    expect(await recordShopifyInstall(fake.tx, { shop: SHOP, scopes: 'read_orders' })).toBe(
      'installed',
    );
    expect(fake.execute).toHaveBeenCalledTimes(1);
    expect(said(fake)).toContain('uninstalled_at = null');
  });

  it('inserts a new row when the winery never held the shop', async () => {
    const fake = fakeTx([], [{ id: 'i-1' }]);

    expect(await recordShopifyInstall(fake.tx, { shop: SHOP, scopes: 'read_orders' })).toBe(
      'installed',
    );
    expect(said(fake, 1)).toContain('on conflict (shop) do nothing');
  });

  it('says the shop is taken when neither touched a row', async () => {
    expect(
      await recordShopifyInstall(fakeTx([], []).tx, { shop: SHOP, scopes: 'read_orders' }),
    ).toBe('shop_taken');
  });
});

describe('markShopifyUninstalled', () => {
  it('marks the shop it was told, and says whether it did', async () => {
    const marked = fakeTx([{ id: 'i-1' }]);

    expect(await markShopifyUninstalled(marked.tx, SHOP)).toBe(true);
    expect(bound(marked)).toEqual([SHOP]);
    expect(await markShopifyUninstalled(fakeTx([]).tx, SHOP)).toBe(false);
  });
});

describe('readShopifyInstallation', () => {
  it('reads the latest install back, installed or uninstalled', async () => {
    expect(
      await readShopifyInstallation(
        fakeTx([
          {
            shop: SHOP,
            scopes: 'read_orders',
            installed_at: '2026-10-02 09:00:00+00',
            uninstalled_at: null,
          },
        ]).tx,
      ),
    ).toEqual({
      shop: SHOP,
      scopes: 'read_orders',
      installedAt: new Date('2026-10-02T09:00:00.000Z'),
      uninstalledAt: null,
    });

    expect(
      (
        await readShopifyInstallation(
          fakeTx([
            {
              shop: SHOP,
              scopes: 'read_orders',
              installed_at: '2026-10-02 09:00:00+00',
              uninstalled_at: '2026-10-03 09:00:00+00',
            },
          ]).tx,
        )
      )?.uninstalledAt,
    ).toEqual(new Date('2026-10-03T09:00:00.000Z'));
  });

  it('is nothing for a winery that never connected a shop', async () => {
    expect(await readShopifyInstallation(fakeTx([]).tx)).toBeUndefined();
  });
});

describe('resolveTenantByShop', () => {
  it('sets the shop flag in a read-only transaction and returns the winery', async () => {
    const fake = fakeDb([], [{ tenant_id: TENANT }]);

    expect(await resolveTenantByShop(SHOP, fake.db)).toBe(TENANT);
    expect(fake.opened).toEqual([{ accessMode: 'read only' }]);
    expect(bound(fake, 0)).toEqual([SHOPIFY_SHOP_GUC, SHOP]);
    expect(said(fake, 1)).toContain('uninstalled_at is null');
  });

  it('is nothing for a shop nobody holds installed', async () => {
    expect(await resolveTenantByShop(SHOP, fakeDb([], []).db)).toBeUndefined();
  });
});
