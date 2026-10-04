import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import { withUser } from './with-user.js';
import { getCurrentTenantId, type DbTransaction } from './with-tenant.js';

/**
 * The Shopify install's statements (P6-06, ADR 0031).
 *
 * Three scopes, each for one step, and none of them new except the last:
 * starting an install is the member's winery (`withTenant`); finishing it is
 * the member (`withUser`), because Shopify's redirect carries no tenant and
 * the state is what says which winery the install was for; and a webhook,
 * which names only a shop, learns the winery from `resolveTenantByShop` —
 * read-only, one row, one table — and hands over to `withTenant`.
 */

export const SHOPIFY_SHOP_GUC = 'app.shopify_shop';

export interface StartedInstall {
  readonly userId: string;
  readonly shop: string;
  /** SHA-256 of the nonce; the nonce is never stored. */
  readonly nonceHash: string;
  readonly expiresAt: Date;
}

/** Records an install the member is about to start, in the scope's winery. */
export const startShopifyInstall = async (
  tx: DbTransaction,
  { userId, shop, nonceHash, expiresAt }: StartedInstall,
): Promise<void> => {
  await tx.execute(sql`
    insert into shopify_oauth_states (tenant_id, user_id, shop, nonce_hash, expires_at)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${userId}, ${shop},
            ${nonceHash}, ${expiresAt.toISOString()}::timestamptz)
  `);
};

export interface SpentState {
  readonly tenantId: string;
  readonly shop: string;
  /** Spent either way: a lapsed state is deleted too, and refused by the caller. */
  readonly expired: boolean;
}

/**
 * Spends a state, once, for the member who started it — or `undefined` when
 * there is no such state for them: never started, already spent, or another
 * member's.
 *
 * **Deleting is the check.** One statement finds the row and removes it, so
 * two callbacks racing with the same state cannot both find it, and a replay
 * finds nothing. In the member's own scope: the callback carries no tenant,
 * and the winery comes from the row the member's own install wrote.
 */
export const spendShopifyState = async (
  userId: string,
  nonceHash: string,
  now: Date = new Date(),
  db: Database = getDb(),
): Promise<SpentState | undefined> =>
  withUser(
    userId,
    async (tx) => {
      const rows = await tx.execute(sql`
        delete from shopify_oauth_states
        where nonce_hash = ${nonceHash} and user_id = ${userId}
        returning tenant_id, shop, expires_at
      `);
      const row = [...rows][0];

      return row === undefined
        ? undefined
        : {
            tenantId: String(row.tenant_id),
            shop: String(row.shop),
            expired: new Date(row.expires_at as string | Date) <= now,
          };
    },
    db,
  );

/**
 * Records the shop as this winery's, installed now — or `shop_taken` when
 * another winery holds it. Reinstalling a shop the winery held before brings
 * the same row back.
 */
export const recordShopifyInstall = async (
  tx: DbTransaction,
  { shop, scopes }: { readonly shop: string; readonly scopes: string },
): Promise<'installed' | 'shop_taken'> => {
  /* The policy narrows this to the winery's own row, so another winery's shop is untouched. */
  const reinstalled = await tx.execute(sql`
    update shopify_installations
    set scopes = ${scopes}, installed_at = now(), uninstalled_at = null
    where shop = ${shop}
    returning id
  `);

  if ([...reinstalled].length > 0) return 'installed';

  /* A conflict on the unique shop is detected whoever holds it; the row stays theirs. */
  const inserted = await tx.execute(sql`
    insert into shopify_installations (tenant_id, shop, scopes)
    values (nullif(current_setting('app.tenant_id', true), '')::uuid, ${shop}, ${scopes})
    on conflict (shop) do nothing
    returning id
  `);

  return [...inserted].length > 0 ? 'installed' : 'shop_taken';
};

/**
 * Marks one of the winery's shops uninstalled — the one the webhook named, never
 * every shop it holds. `false` when that shop was not installed for it.
 */
export const markShopifyUninstalled = async (tx: DbTransaction, shop: string): Promise<boolean> => {
  const rows = await tx.execute(sql`
    update shopify_installations
    set uninstalled_at = now()
    where shop = ${shop} and uninstalled_at is null
    returning id
  `);

  return [...rows].length > 0;
};

export interface ShopifyInstallation {
  readonly shop: string;
  readonly scopes: string;
  readonly installedAt: Date;
  readonly uninstalledAt: Date | null;
}

/** The winery's shop, if it ever connected one: the latest install. */
export const readShopifyInstallation = async (
  tx: DbTransaction,
): Promise<ShopifyInstallation | undefined> => {
  const rows = await tx.execute(sql`
    select shop, scopes, installed_at, uninstalled_at
    from shopify_installations
    order by installed_at desc
    limit 1
  `);
  const row = [...rows][0];

  return row === undefined
    ? undefined
    : {
        shop: String(row.shop),
        scopes: String(row.scopes),
        installedAt: new Date(row.installed_at as string | Date),
        uninstalledAt:
          row.uninstalled_at === null ? null : new Date(row.uninstalled_at as string | Date),
      };
};

/** Opened inside a tenant scope, the shop branch would be OR-ed with the tenant's own. */
export class NestedShopifyScopeError extends Error {
  constructor(tenantId: string) {
    super(
      `Cannot resolve a Shopify shop inside withTenant("${tenantId}"): the policy's tenant ` +
        "and shop branches are OR-ed, and the read would see another winery's installation.",
    );
    this.name = 'NestedShopifyScopeError';
  }
}

/**
 * The winery that holds a shop with the app installed, or `undefined` (ADR
 * 0031).
 *
 * **Read-only, one statement, one table.** The flag admits the one
 * installation row for the shop and nothing anywhere else; the transaction is
 * `READ ONLY`, so even a mistake here cannot write; and the caller does
 * everything else in `withTenant` for the id this returns.
 */
export const resolveTenantByShop = async (
  shop: string,
  db: Database = getDb(),
): Promise<string | undefined> => {
  const active = getCurrentTenantId();

  if (active !== undefined) throw new NestedShopifyScopeError(active);

  return db.transaction(
    async (tx) => {
      await tx.execute(sql`select set_config(${SHOPIFY_SHOP_GUC}, ${shop}, true)`);

      const rows = await tx.execute(sql`
        select tenant_id from shopify_installations
        where shop = ${shop} and uninstalled_at is null
      `);
      const row = [...rows][0];

      return row === undefined ? undefined : String(row.tenant_id);
    },
    { accessMode: 'read only' },
  );
};
