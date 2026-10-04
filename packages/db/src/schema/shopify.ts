import { sql } from 'drizzle-orm';
import { check, index, pgTable, text, timestamp, uuid } from 'drizzle-orm/pg-core';

import { authUsers } from './auth.js';
import { tenants } from './tenants.js';

/**
 * A winery's Shopify store (P6-06): which shop, what it granted, and whether
 * the app is still installed.
 *
 * **One shop, one winery.** `shop` is unique across tenants: an install that
 * names a shop another winery holds is refused, because the orders that shop
 * reports (P6-07) would otherwise be attributed to whichever winery connected
 * it last.
 *
 * **The token is not here.** It is a credential to the seller's store and
 * lives encrypted in SSM (ADR 0031); a row in a table every query on the
 * tenant path can read is not where a credential goes.
 *
 * **Reachable by shop, read-only, before a tenant is known** — a webhook names
 * its shop and nothing else. `resolveTenantByShop` sets `app.shopify_shop` in
 * a `READ ONLY` transaction, and the policy admits this table's one row for
 * that shop and nothing on any other table (ADR 0031).
 */
export const shopifyInstallations = pgTable(
  'shopify_installations',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    /** The permanent `*.myshopify.com` name, as Shopify signs it. */
    shop: text('shop').notNull().unique(),
    /** What the shop granted, as Shopify reported it. */
    scopes: text('scopes').notNull(),
    installedAt: timestamp('installed_at', { withTimezone: true, mode: 'date' })
      .notNull()
      .defaultNow(),
    /** Set by `app/uninstalled`; the token is deleted with it. */
    uninstalledAt: timestamp('uninstalled_at', { withTimezone: true, mode: 'date' }),
  },
  (table) => [
    check(
      'shopify_installations_shop_format',
      sql`shop ~ '^[a-z0-9][a-z0-9-]{0,59}\\.myshopify\\.com$'`,
    ),
    index('shopify_installations_tenant_id_idx').on(table.tenantId),
  ],
);

/**
 * An install that was started and not yet finished (P6-06): the `state` of
 * the OAuth round trip.
 *
 * **Single use, short-lived, and bound to the member who started it.** The
 * callback finds its row in that member's own scope (`withUser`), so a state
 * started by somebody else does not exist for them, and *deletes* it — one
 * statement that is both the check and the spending. Only the nonce's hash is
 * kept.
 */
export const shopifyOauthStates = pgTable(
  'shopify_oauth_states',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    tenantId: uuid('tenant_id')
      .notNull()
      .references(() => tenants.id, { onDelete: 'cascade' }),
    userId: text('user_id')
      .notNull()
      .references(() => authUsers.id, { onDelete: 'cascade' }),
    shop: text('shop').notNull(),
    /** SHA-256 of the nonce, hex. The nonce itself is in the seller's browser and nowhere else. */
    nonceHash: text('nonce_hash').notNull().unique(),
    expiresAt: timestamp('expires_at', { withTimezone: true, mode: 'date' }).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true, mode: 'date' }).notNull().defaultNow(),
  },
  (table) => [index('shopify_oauth_states_user_id_idx').on(table.userId)],
);
