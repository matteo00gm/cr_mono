import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { productsImportedResponse } from '@catalogorosso/api-client';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createApp } from '../src/app.js';
import { createProductsPort } from '../src/products.js';
import { oneMembership, signedIn } from './support/auth.js';

/**
 * Import is an upsert, never a sync (§2.2b, P1-29).
 *
 * **A guard, not a feature.** Every import path adds and updates; none removes.
 * A wine missing from a file is not a request to archive it — a seller who
 * exports one shelf of the shop to fix its prices would otherwise hide the rest
 * of the catalogue from every visitor. The day somebody adds a sync mode, this
 * is the test that has to change, beside the reason it exists, and the change
 * belongs in an action labelled as what it is.
 *
 * **Through the real route, the real port and real Postgres**, because the
 * property belongs to the whole path: a route that filtered rows, a port that
 * batched them wrongly, or a statement that archived absent SKUs would each
 * break it, and a test of any one layer would miss the other two.
 */

let harness: TestDatabase | undefined;
let tenantId = '';

const IMPORT = '/v1/dashboard/products/import';

const wine = (index: number, over: Record<string, unknown> = {}) => ({
  sku: `SHELF-${String(index)}`,
  name: `Vino ${String(index)}`,
  wineType: 'red',
  priceCents: 1500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
  ...over,
});

beforeAll(async () => {
  harness = await startTestDatabase();

  // Read by the package's memoised client, so set before the port first opens a transaction.
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  tenantId = randomUUID();
  await harness.adminDb.execute(sql`
    insert into tenants (id, name, slug) values (${tenantId}::uuid, 'Scaffale', ${`scaffale-${tenantId}`})
  `);
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

/** One import through the whole application, as an EDITOR pasting rows would send it. */
const importing = async (rows: readonly Record<string, unknown>[]) => {
  const app = createApp({
    auth: signedIn(),
    readMemberships: oneMembership(tenantId, 'EDITOR'),
    products: createProductsPort(),
  });

  const response = await app.request(IMPORT, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'idempotency-key': randomUUID() },
    body: JSON.stringify({ rows, source: { entryPoint: 'paste' } }),
  });

  if (response.status !== 200) {
    throw new Error(`the import answered ${String(response.status)}: ${await response.text()}`);
  }

  return productsImportedResponse.parse(await response.json());
};

const countWhere = async (query: ReturnType<typeof sql>): Promise<number> => {
  const rows = await harness?.adminDb.execute(query);
  return ([...(rows ?? [])][0] as { n: number }).n;
};

describe('import semantics (§2.2b)', () => {
  it('import never archives products absent from the payload', async () => {
    await importing(Array.from({ length: 10 }, (_, index) => wine(index)));

    // Three of the ten, one of them repriced, and two wines the catalogue has never seen.
    const second = await importing([
      wine(0),
      wine(1, { priceCents: 1800 }),
      wine(2),
      wine(10),
      wine(11),
    ]);

    expect(second.counts).toEqual({
      created: 2,
      updated: 1,
      unchanged: 2,
      duplicateSku: 0,
      archived: 0,
    });

    expect(
      await countWhere(
        sql`select count(*)::int as n from products where tenant_id = ${tenantId}::uuid`,
      ),
    ).toBe(12);

    // All ten originals, the seven the second import never mentioned included, are still ACTIVE.
    expect(
      await countWhere(sql`
        select count(*)::int as n from products
        where tenant_id = ${tenantId}::uuid and sku ~ '^SHELF-[0-9]$' and status = 'ACTIVE'
      `),
    ).toBe(10);

    expect(
      await countWhere(sql`
        select count(*)::int as n from products
        where tenant_id = ${tenantId}::uuid and status <> 'ACTIVE'
      `),
    ).toBe(0);
  });
});
