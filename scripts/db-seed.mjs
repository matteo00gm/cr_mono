#!/usr/bin/env node
/**
 * Seeds two tenants with products, for local development (P0-43).
 *
 * Two rather than one, always. A single-tenant database makes every isolation
 * bug invisible: a missing `WHERE tenant_id` returns the right answer when
 * there is only one tenant's data to return, and looks correct until the day it
 * is not. Anyone poking at a seeded database by hand should be able to see
 * isolation working.
 *
 * **Sets the tenant GUC before every write**, because P0-37 requires it — this
 * script connects as `app_rw` and is subject to the same policies the
 * application is. Seeding as the migration role or the master would work and
 * would be exactly the wrong lesson.
 *
 * Reads `DATABASE_URL`, the same variable the application reads, so seeding a
 * database the app cannot reach is not possible.
 */
import process from 'node:process';

import postgres from 'postgres';

import { makeMembership, makeProduct, makeTenant } from '../packages/testing/dist/factories.js';

const TENANTS = 2;
const PRODUCTS_PER_TENANT = 4;

const main = async () => {
  const url = process.env.DATABASE_URL;

  if (!url) {
    console.error('db-seed: DATABASE_URL is not set');
    process.exitCode = 1;
    return;
  }

  // `max: 1`: the tenant GUC is session state, so every statement for a tenant
  // has to run on the connection that set it.
  const sql = postgres(url, { max: 1 });

  try {
    for (let t = 0; t < TENANTS; t += 1) {
      const tenant = makeTenant({ name: t === 0 ? 'Cantina Còlpetrone' : 'Feudo Montoni' });

      await sql`select set_config('app.tenant_id', ${tenant.id}, false)`;
      await sql`
        insert into tenants (id, name, slug, locale, currency)
        values (${tenant.id}, ${tenant.name}, ${tenant.slug}, ${tenant.locale}, ${tenant.currency})
      `;

      const owner = makeMembership();
      await sql`
        insert into memberships (tenant_id, user_id, role)
        values (${tenant.id}, ${owner.userId}, ${owner.role})
      `;

      for (let p = 0; p < PRODUCTS_PER_TENANT; p += 1) {
        const product = makeProduct(p);

        await sql`
          insert into products (
            tenant_id, sku, name, producer, wine_type, price_cents, currency, stock_status,
            grape_varieties, food_pairings, alcohol_pct
          )
          values (
            ${tenant.id}, ${product.sku}, ${product.name}, ${product.producer},
            ${product.wineType}, ${product.priceCents}, ${product.currency}, ${product.stockStatus},
            ${product.grapeVarieties}, ${product.foodPairings}, ${product.alcoholPct}
          )
        `;
      }

      console.log(
        `db-seed: ${tenant.name} (${tenant.id}) with ${String(PRODUCTS_PER_TENANT)} products`,
      );
    }

    console.log('db-seed: done');
  } finally {
    await sql.end();
  }
};

await main();
