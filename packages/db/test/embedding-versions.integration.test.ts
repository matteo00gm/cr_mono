import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import type { ProductInsert } from '../src/contracts.js';
import {
  activeEmbeddingVersionFilter,
  readActiveEmbeddingVersion,
  readProductForEmbedding,
  switchEmbeddingVersion,
  upsertEmbedding,
} from '../src/embeddings.js';
import { insertProduct } from '../src/products.js';
import { withTenant, type DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Two embedding generations for one tenant, against real Postgres (P1-49).
 *
 * The row's tests: two versions coexist, retrieval reads only the active one,
 * the cutover is refused while any active wine lacks a vector in the new
 * version and allowed once none does, and flipping back restores what was
 * answered before. None of it is visible to a fake — it is a unique key, a
 * pointer read inside a similarity query, and a count under RLS.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 2 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'versions');
});

const inTenant = <T>(run: (tx: DbTransaction) => Promise<T>, tenant = tenantId): Promise<T> =>
  withTenant(tenant, run, db);

const addWine = async (sku: string, tenant = tenantId): Promise<string> => {
  const values = {
    sku,
    name: `Vino ${sku}`,
    wineType: 'red',
    priceCents: 2500,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
  } as ProductInsert;

  const created = await inTenant(
    (tx) => insertProduct(tx, { tenantId: tenant, values, contentHash: `hash-${sku}` }),
    tenant,
  );
  if (created.outcome !== 'created') throw new Error('seed failed');
  return created.product.id;
};

/** Half the dimensions lit, so two such vectors are either identical or orthogonal. */
const DIMENSIONS = 1024;
const leftHalf = Array.from({ length: DIMENSIONS }, (_, index) => (index < DIMENSIONS / 2 ? 1 : 0));
const rightHalf = Array.from({ length: DIMENSIONS }, (_, index) =>
  index < DIMENSIONS / 2 ? 0 : 1,
);

const store = (productId: string, version: number, embedding: number[], tenant = tenantId) =>
  inTenant(
    (tx) =>
      upsertEmbedding(tx, {
        tenantId: tenant,
        productId,
        contentHash: `v${String(version)}-${productId}`,
        embedding,
        model: `generation-${String(version)}`,
        version,
      }),
    tenant,
  );

/** What a similarity search ranks for a query, reading only the active generation. */
const ranked = (query: number[]) =>
  inTenant(async (tx) => {
    const rows = await tx.execute(sql`
      select e.product_id
        from product_embeddings e
       where ${activeEmbeddingVersionFilter('e')}
       order by e.embedding <=> ${`[${query.join(',')}]`}::halfvec
    `);
    return [...rows].map((row) => String(row.product_id));
  });

describe('two generations', () => {
  it('coexist for one wine, each read and replaced on its own', async () => {
    // Dual-write's precondition: the key admits a second generation of a chunk.
    const wine = await addWine('DUAL');

    await store(wine, 1, leftHalf);
    await store(wine, 2, rightHalf);
    await store(wine, 2, leftHalf);

    const rows = await inTenant((tx) =>
      tx.execute(sql`
        select version, content_hash from product_embeddings
         where product_id = ${wine}::uuid order by version
      `),
    );
    expect([...rows].map((row) => Number(row.version))).toEqual([1, 2]);

    const v1 = await inTenant((tx) => readProductForEmbedding(tx, wine, 1));
    const v2 = await inTenant((tx) => readProductForEmbedding(tx, wine, 2));
    expect(v1?.embeddedHash).toBe(`v1-${wine}`);
    expect(v2?.embeddedHash).toBe(`v2-${wine}`);
  });

  it('are ranked by the tenant’s active one only, and flipping back restores the answer', async () => {
    const left = await addWine('LEFT');
    const right = await addWine('RIGHT');

    // Generation 1 puts LEFT nearest the query; generation 2 says the opposite.
    await store(left, 1, leftHalf);
    await store(right, 1, rightHalf);
    await store(left, 2, rightHalf);
    await store(right, 2, leftHalf);

    expect(await ranked(leftHalf)).toEqual([left, right]);

    await inTenant((tx) => switchEmbeddingVersion(tx, { tenantId, version: 2 }));
    expect(await ranked(leftHalf)).toEqual([right, left]);

    await inTenant((tx) => switchEmbeddingVersion(tx, { tenantId, version: 1 }));
    expect(await ranked(leftHalf)).toEqual([left, right]);
  });
});

describe('the cutover', () => {
  it('is refused while an active wine lacks a vector in the new generation, and allowed after', async () => {
    const first = await addWine('ONE');
    const second = await addWine('TWO');
    await store(first, 1, leftHalf);
    await store(second, 1, leftHalf);
    await store(first, 2, leftHalf);

    expect(await inTenant((tx) => switchEmbeddingVersion(tx, { tenantId, version: 2 }))).toEqual({
      outcome: 'incomplete',
      version: 2,
      missing: 1,
    });
    expect(await inTenant((tx) => readActiveEmbeddingVersion(tx, tenantId))).toBe(1);

    await store(second, 2, leftHalf);

    expect(await inTenant((tx) => switchEmbeddingVersion(tx, { tenantId, version: 2 }))).toEqual({
      outcome: 'switched',
      from: 1,
      to: 2,
    });
    expect(await inTenant((tx) => readActiveEmbeddingVersion(tx, tenantId))).toBe(2);
  });

  it('does not wait for an archived wine, which has no vector to build', async () => {
    const kept = await addWine('KEPT');
    const archived = await addWine('GONE');
    await store(kept, 2, leftHalf);
    await inTenant((tx) =>
      tx.execute(sql`update products set status = 'ARCHIVED' where id = ${archived}::uuid`),
    );

    expect(
      (await inTenant((tx) => switchEmbeddingVersion(tx, { tenantId, version: 2 }))).outcome,
    ).toBe('switched');
  });

  it('moves only the tenant it was run for, and cannot reach another', async () => {
    const other = await createTenant(db, 'versions-other');

    await inTenant((tx) => switchEmbeddingVersion(tx, { tenantId: other, version: 3 }), other);

    expect(await inTenant((tx) => readActiveEmbeddingVersion(tx, tenantId))).toBe(1);
    // Scoped to this tenant, the other's row is invisible: refused, not moved.
    await expect(
      inTenant((tx) => switchEmbeddingVersion(tx, { tenantId: other, version: 1 })),
    ).rejects.toThrow(/not visible/);
    expect(await inTenant((tx) => readActiveEmbeddingVersion(tx, other), other)).toBe(3);
  });
});
