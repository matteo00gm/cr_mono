import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres, type TestPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
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

  tenantId = await createTenant(db, 'embeddings');

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

/**
 * Re-scope before every test (P0-37).
 *
 * The tenant GUC is session state, so any test that creates a second tenant
 * moves the context and leaves the next one reading as somebody else. Setting
 * it here makes each test independent of what ran before it, which is what the
 * shared `tenantId` from `beforeAll` already implied.
 */
beforeEach(async () => {
  await useTenant(db, tenantId);
});

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

  it('has an HNSW index on the vector, with the operator class cosine needs', async () => {
    /*
     * The half of the plan assertion that cannot flake: the index exists, it is
     * HNSW, and it is built for the operator the retrieval query uses.
     *
     * **`halfvec_cosine_ops` is the load-bearing word.** An index built for L2
     * (`halfvec_l2_ops`) is a perfectly valid index that the `<=>` operator can
     * never use, so retrieval would silently fall back to a scan — the same
     * latency cliff as having no index, with an index in the schema to reassure
     * whoever goes looking.
     */
    const rows = await db.execute(sql`
      select indexdef from pg_indexes
      where tablename = 'product_embeddings' and indexname = 'product_embeddings_embedding_hnsw'
    `);

    const definition = ([...rows][0] as { indexdef?: string } | undefined)?.indexdef ?? '';

    expect(definition).toContain('USING hnsw');
    expect(definition).toContain('halfvec_cosine_ops');
  });

  it('can serve the ordering from the HNSW index at all', async () => {
    /*
     * **The failure this catches is the one that has actually happened**, and
     * migration 0011's own comment records it: with an l2 index in place, the
     * cosine query plans as a Seq Scan. An index built for the wrong operator
     * class is a valid index that `<=>` can never use, so retrieval silently
     * falls back to sorting the table — a latency cliff nobody notices until a
     * tenant with a real catalogue arrives.
     *
     * Asserted by taking the alternatives away rather than by hoping the
     * planner prefers the index. With `enable_seqscan` and `enable_sort` off,
     * the only remaining way to produce rows in distance order is an ordered
     * index scan on the vector — so if the index cannot serve the operator, the
     * plan falls back to a disabled node and this fails. Disabled nodes are
     * costed at 1e10, not forbidden, so the planner still answers honestly.
     *
     * **This is not the same claim as "the planner chooses it", and the
     * difference is why the previous version of this test flaked.** That
     * version asserted the *default* plan, and at this data size the two plans
     * are within five per cent of each other. From the run that failed:
     *
     *     Seq Scan  cost 212.02, rows 5001
     *     Sort      cost 324.55
     *     Limit     cost 312.06   <- what the index had to beat
     *
     * A margin that thin is decided by the index's page count, which varies
     * with five thousand random vectors, so the outcome was a coin flip. It
     * came up tails on four CI runs across branches that touch nothing near
     * this file, and heads on a re-run of each of those same commits.
     *
     * Whether the planner *prefers* the index has since been measured, and the
     * answer is no: at this product's ceiling — ten tenants of two thousand
     * wines — an exact sequential scan over one tenant's vectors is ~6 ms and
     * wins outright. That is correct rather than a defect, and it is why this
     * file asserts the index is *usable* rather than *used*.
     *
     * The measurement surfaced something worse, recorded on P2-18: a filtered
     * search through this index can return fewer rows than asked for — zero of
     * eight at realistic tenant skew — because the graph walk spends its
     * candidate budget before the tenant predicate is applied. So an assertion
     * that retrieval *uses* this index would be a test pushing retrieval
     * towards the plan that loses rows.
     */
    const migrator = createDbClient(started.roleUrl('app_migrate'), { max: 1 });

    // Its own connection, so it needs its own context. FORCE ROW LEVEL
    // SECURITY applies to the table owner too — which is the whole reason
    // FORCE is there — so app_migrate is filtered exactly like app_rw.
    await useTenant(migrator.db, tenantId);

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

      const plan = await db.transaction(async (tx) => {
        await tx.execute(sql`set local enable_seqscan = off`);
        await tx.execute(sql`set local enable_sort = off`);

        return tx.execute(sql`
          explain (format json)
          select id from product_embeddings
          order by embedding <=> ${randomVector()}::halfvec
          limit 8
        `);
      });

      expect(JSON.stringify([...plan][0])).toContain('product_embeddings_embedding_hnsw');
    } finally {
      await migrator.close();
    }
  }, 120_000);
});
