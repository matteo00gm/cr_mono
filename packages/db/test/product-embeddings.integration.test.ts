import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres, type TestPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `product_embeddings` against real Postgres (P0-27).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

const UNIQUE_VIOLATION = '23505';
/** data_exception — what a wrong-dimension vector literal raises. */
const DATA_EXCEPTION = '22000';

/**
 * Enough rows that an index scan is cheaper than a sort.
 *
 * Measured, not guessed: at 500 rows the planner still chooses a sequential
 * scan and the assertion below would fail; at 5,000 it takes the HNSW index.
 * Generated server-side in one statement, so the cost is a few seconds rather
 * than 5,000 round trips carrying 1,024 floats each.
 */
const SEED_ROWS = 5_000;

const randomVector = () =>
  `[${Array.from({ length: 1024 }, () => Math.random().toFixed(4)).join(',')}]`;

let container: StartedPostgreSqlContainer | undefined;
let started: TestPostgres;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let productId: string;

beforeAll(async () => {
  started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  const tenant = await db.execute(
    sql`insert into tenants (name, slug) values ('Embeddings', 'embeddings') returning id`,
  );
  tenantId = String([...tenant][0]?.id);

  const product = await db.execute(sql`
    insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
    values (${tenantId}::uuid, 'SKU-EMB', 'Barolo', 'RED', 3500, 'EUR', 'IN_STOCK')
    returning id
  `);
  productId = String([...product][0]?.id);
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

describe('product_embeddings', () => {
  it('stores and returns a 1024-dimension vector', async () => {
    await db.execute(sql`
      insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
      values (${tenantId}::uuid, ${productId}::uuid, 0, 'hash-0',
              ${randomVector()}::halfvec, 'amazon.titan-embed-text-v2')
    `);

    const rows = await db.execute(sql`
      select vector_dims(embedding) as dims, model
      from product_embeddings where product_id = ${productId}::uuid and chunk_idx = 0
    `);

    // The dimension is read from the vector itself. There is no `dim` column to
    // disagree with it.
    expect([...rows][0]).toMatchObject({ dims: 1024 });
  });

  it('rejects a vector of the wrong dimension', async () => {
    // The failure this prevents is a model swap that half-works: a 1536-dim
    // model writing into a 1024 column would otherwise need to be caught by
    // whoever notices the recommendations got worse.
    const error = await db
      .execute(
        sql`insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
            values (${tenantId}::uuid, ${productId}::uuid, 99, 'hash-bad',
                    ${'[0.1,0.2,0.3]'}::halfvec, 'wrong-model')`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(DATA_EXCEPTION);
  });

  it('refuses a second vector for the same product chunk', async () => {
    // Re-indexing has to be an upsert. As an append it doubles a product's
    // vectors and skews every ranking it appears in.
    const error = await db
      .execute(
        sql`insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
            values (${tenantId}::uuid, ${productId}::uuid, 0, 'hash-0',
                    ${randomVector()}::halfvec, 'amazon.titan-embed-text-v2')`,
      )
      .catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('hard-deletes vectors when their product is deleted', async () => {
    // §4.3. P1-04 deletes them explicitly; this is the half the database
    // guarantees, so a missed code path cannot leave a deleted wine
    // recommendable.
    const product = await db.execute(sql`
      insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
      values (${tenantId}::uuid, 'SKU-DOOMED', 'Doomed', 'RED', 100, 'EUR', 'IN_STOCK')
      returning id
    `);
    const doomed = String([...product][0]?.id);

    await db.execute(sql`
      insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
      values (${tenantId}::uuid, ${doomed}::uuid, 0, 'h', ${randomVector()}::halfvec, 'm')
    `);
    await db.execute(sql`delete from products where id = ${doomed}::uuid`);

    const rows = await db.execute(
      sql`select 1 from product_embeddings where product_id = ${doomed}::uuid`,
    );
    expect([...rows]).toHaveLength(0);
  });

  it('serves a similarity search from the HNSW index rather than a scan', async () => {
    /*
     * The assertion the plan asks for, set up so it can actually hold.
     *
     * A silently unused index is a latency cliff nobody notices until a tenant
     * with a real catalog arrives — retrieval keeps returning correct results
     * and simply gets slower. Two things are needed for the planner to reveal
     * that here: enough rows that the index is cheaper than a sort, and
     * statistics, which means ANALYZE — and ANALYZE requires table ownership,
     * so it runs on an app_migrate connection rather than app_rw.
     */
    const migrator = createDbClient(started.roleUrl('app_migrate'), { max: 1 });

    try {
      await migrator.db.execute(sql`
        insert into products (tenant_id, sku, name, wine_type, price_cents, currency, stock_status)
        select ${tenantId}::uuid, 'BULK-' || g, 'Vino ' || g, 'RED', 100, 'EUR', 'IN_STOCK'
        from generate_series(1, ${SEED_ROWS}) g
      `);
      await migrator.db.execute(sql`
        insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
        select p.tenant_id, p.id, 0, 'bulk',
               (select '[' || string_agg(random()::text, ',') || ']' from generate_series(1, 1024))::halfvec,
               'amazon.titan-embed-text-v2'
        from products p where p.sku like 'BULK-%'
      `);
      await migrator.db.execute(sql`analyze product_embeddings`);

      const plan = await db.execute(sql`
        explain (format json)
        select id from product_embeddings
        order by embedding <=> ${randomVector()}::halfvec
        limit 8
      `);

      expect(JSON.stringify([...plan][0])).toContain('product_embeddings_embedding_hnsw');
    } finally {
      await migrator.close();
    }
  }, 120_000);
});
