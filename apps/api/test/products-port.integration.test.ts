import process from 'node:process';
import { randomUUID } from 'node:crypto';
import { contentHashOf } from '@catalogorosso/core';
import { startTestDatabase, type TestDatabase } from '@catalogorosso/testing';
import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createProductsPort, type ProductsPort } from '../src/products.js';
import { createWebhooksPort, type WebhooksPort } from '../src/webhooks.js';

/**
 * The real ports, against real Postgres (P1-02 … P1-06, P0-64b).
 *
 * **This is the seam nothing covered.** `apps/api/test/products.test.ts` and
 * friends drive the routes with a *fake* port, which proves the HTTP contract
 * and proves nothing about the twenty lines that turn a command into a
 * `withTenant` transaction. `packages/db`'s integration suites drive the
 * statements directly, which proves the SQL and proves nothing about what the
 * port passes them.
 *
 * Between the two sat `createProductsPort` at 43% of lines and
 * `createWebhooksPort` at 20% — and the bug that lives there is an argument in
 * the wrong position. `withTenant(command.productId, …)` typechecks, because
 * both are strings and both are uuids. It would open a transaction for a tenant
 * that does not exist, find no product, and return `not-found` for every
 * request — which reads as "the catalogue is empty" rather than as a bug.
 */

let harness: TestDatabase | undefined;
let products: ProductsPort;
let webhooks: WebhooksPort;
let tenantId: string;
let otherTenantId: string;

const VALUES = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK' as const,
  tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
  foodPairings: ['brasato'],
};

const makeTenant = async (label: string): Promise<string> => {
  const id = randomUUID();

  if (harness === undefined) throw new Error('harness not started');

  await harness.adminDb.execute(sql`
    insert into tenants (id, name, slug) values (${id}::uuid, ${label}, ${`${label}-${id}`})
  `);

  return id;
};

beforeAll(async () => {
  harness = await startTestDatabase();

  /*
   * The ports call `withTenant` with the package's memoised client, which reads
   * this. Set before the ports are built, for the same reason the auth suite
   * sets it before `createAuth` runs: the client is created once and kept.
   */
  process.env.DATABASE_URL = harness.roleUrl('app_rw');

  products = createProductsPort();
  webhooks = createWebhooksPort();
}, 180_000);

afterAll(async () => {
  await harness?.close();
}, 60_000);

beforeEach(async () => {
  tenantId = await makeTenant('port');
  otherTenantId = await makeTenant('port-other');
});

const create = async (tenant = tenantId, sku = VALUES.sku) =>
  products.create({
    tenantId: tenant,
    values: { ...VALUES, sku },
  });

describe('createProductsPort', () => {
  it('writes the product under the tenant the command names', async () => {
    /*
     * **The argument-in-the-wrong-position test.** Both ids are uuid strings,
     * so passing `productId` where `tenantId` belongs typechecks — and the
     * symptom is every request returning not-found, which reads as an empty
     * catalogue rather than as a bug.
     */
    const created = await create();

    expect(created.outcome).toBe('created');

    if (created.outcome !== 'created') return;

    const rows = await harness?.adminDb.execute(
      sql`select tenant_id from products where id = ${created.product.id}::uuid`,
    );

    expect(String([...(rows ?? [])][0]?.tenant_id)).toBe(tenantId);
  });

  it('queues the embedding job in the same transaction', async () => {
    /*
     * §4.1's guarantee, checked through the port rather than through the
     * statement. `insertProduct` pairs them; this is the half that shows the
     * port actually calls it — a port that inserted the product by some other
     * route would pass every route test and leave the wine unsearchable.
     */
    const created = await create();

    if (created.outcome !== 'created') throw new Error('expected a product');

    const rows = await harness?.adminDb.execute(
      sql`select event_type from outbox where aggregate_id = ${created.product.id}::uuid`,
    );

    expect([...(rows ?? [])]).toHaveLength(1);
  });

  it('reports a duplicate SKU rather than throwing', async () => {
    // The branch that needs a real unique constraint: postgres-js poisons a
    // transaction on any statement error, so this only behaves through
    // `ON CONFLICT DO NOTHING` and only a database can show that.
    await create();

    expect((await create()).outcome).toBe('duplicate-sku');
  });

  it('lets two tenants hold the same SKU', async () => {
    // The constraint is on `(tenant_id, sku)`. A port that scoped the write
    // wrongly would surface here as a duplicate across unrelated sellers.
    await create(tenantId);

    expect((await create(otherTenantId)).outcome).toBe('created');
  });

  it('updates under the tenant, and computes the hash from the merged row', async () => {
    /*
     * `hashOf` is wired by the port, and it is the input to whether an edit
     * costs an embedding. Given the wrong argument it would hash the *patch*
     * rather than the merged product, so every edit would look like a change
     * and every edit would re-embed.
     */
    const created = await create();

    if (created.outcome !== 'created') throw new Error('expected a product');

    const updated = await products.update({
      tenantId,
      productId: created.product.id,
      values: { tastingNotes: 'Riscritta.' },
    });

    expect(updated.outcome).toBe('updated');

    if (updated.outcome !== 'updated') return;

    expect(updated.reindexed).toBe(true);
    expect(updated.product.contentHash).toBe(
      contentHashOf({ ...updated.product, tastingNotes: 'Riscritta.' }),
    );
  });

  it('does not re-index an edit the model cannot see', async () => {
    const created = await create();

    if (created.outcome !== 'created') throw new Error('expected a product');

    const updated = await products.update({
      tenantId,
      productId: created.product.id,
      values: { stockQty: 12 },
    });

    expect(updated.outcome === 'updated' && updated.reindexed).toBe(false);
  });

  it('returns not-found for another tenant’s product rather than touching it', async () => {
    /*
     * **§3.5's rule, reached through the port.** The route turns this into a
     * 404 rather than a 403 — the difference tells an attacker the resource
     * exists — and what makes it true is that the transaction is opened for the
     * caller's tenant, so the policy matches nothing.
     */
    const created = await create();

    if (created.outcome !== 'created') throw new Error('expected a product');

    const updated = await products.update({
      tenantId: otherTenantId,
      productId: created.product.id,
      values: { tastingNotes: 'Non mia.' },
    });

    expect(updated.outcome).toBe('not-found');

    const rows = await harness?.adminDb.execute(
      sql`select tasting_notes from products where id = ${created.product.id}::uuid`,
    );

    expect(String([...(rows ?? [])][0]?.tasting_notes)).toBe(VALUES.tastingNotes);
  });

  it('archives the product and deletes its vectors', async () => {
    /*
     * P1-04's whole point, through the port: an archived wine keeps its row and
     * loses its embeddings, or it stays recommendable to visitors while hidden
     * from the seller.
     */
    const created = await create();

    if (created.outcome !== 'created') throw new Error('expected a product');

    await harness?.adminDb.execute(sql`
      insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
      values (${tenantId}::uuid, ${created.product.id}::uuid, 0, 'h',
              ${`[${Array.from({ length: 1024 }, () => '0.1').join(',')}]`}::halfvec, 'm')
    `);

    const archived = await products.archive({ tenantId, productId: created.product.id });

    expect(archived.outcome).toBe('archived');

    const vectors = await harness?.adminDb.execute(
      sql`select 1 from product_embeddings where product_id = ${created.product.id}::uuid`,
    );

    expect([...(vectors ?? [])]).toHaveLength(0);
  });

  it('lists only the calling tenant’s catalogue', async () => {
    await create(tenantId, 'MINE-1');
    await create(otherTenantId, 'THEIRS-1');

    const page = await products.list({ tenantId });

    expect(page.items.map((item) => item.sku)).toEqual(['MINE-1']);
  });
});

describe('createWebhooksPort', () => {
  const bounce = (eventId: string) => ({
    eventId,
    payload: {
      type: 'email.bounced',
      data: {
        to: ['hard@example.test'],
        bounce: { type: 'Permanent', subType: 'NoEmail', message: 'no such mailbox' },
      },
    },
  });

  it('records a suppression and reports it as new', async () => {
    const result = await webhooks.record(bounce(`evt_${randomUUID()}`));

    expect(result.duplicate).toBe(false);

    const rows = await harness?.adminDb.execute(
      sql`select address from email_suppressions where address = 'hard@example.test'`,
    );

    expect([...(rows ?? [])]).toHaveLength(1);
  });

  it('reports a redelivered event as a duplicate without applying it twice', async () => {
    /*
     * **The claim is the port's whole job**, and it needs the real
     * `processed_webhooks` unique index: Resend retries every non-2xx, so this
     * path runs more than once for the same event as a matter of course. A port
     * that lost the claim would suppress twice — harmless here, and the same
     * mechanism is what stops a future paid event applying twice.
     */
    const event = bounce(`evt_${randomUUID()}`);

    expect((await webhooks.record(event)).duplicate).toBe(false);
    expect((await webhooks.record(event)).duplicate).toBe(true);

    const rows = await harness?.adminDb.execute(
      sql`select count(*)::int as n from email_suppressions where address = 'hard@example.test'`,
    );

    expect(Number([...(rows ?? [])][0]?.n)).toBe(1);
  });
});
