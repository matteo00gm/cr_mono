import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { vectorSearch } from '../src/retrieval.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Vector search against real pgvector (P2-18, §4.4).
 *
 * **The assertion is the result, not the plan.** Migration 0011 measured a
 * filtered HNSW search returning zero of eight rows for a small tenant beside a
 * large one, because the graph walk spends its candidate budget before the
 * tenant predicate is applied. So this suite never demands an index scan — it
 * demands the *exact* top-k, compared against the ordering the same vectors
 * give by hand. That catches under-return whatever plan Postgres chooses, and
 * under-return is what a seller would experience as "my wine is never
 * recommended".
 */

const DIMENSIONS = 1024;

/**
 * A wine whose distance from the query is known by construction.
 *
 * Each vector is the query's own axis plus a growing amount of another, so the
 * cosine ordering is unambiguous at half precision: separation between
 * neighbours is percentage points, not rounding.
 */
const vectorFor = (index: number): number[] => {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[0] = 1;
  vector[index + 1] = index * 0.5;

  return vector;
};

const QUERY = ((): number[] => {
  const vector = Array.from({ length: DIMENSIONS }, () => 0);
  vector[0] = 1;

  return vector;
})();

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

const addWine = async (
  tenant: string,
  {
    name,
    index,
    status = 'ACTIVE',
    version = 1,
    chunks = 1,
  }: {
    name: string;
    index: number;
    status?: 'ACTIVE' | 'ARCHIVED';
    version?: number;
    chunks?: number;
  },
): Promise<string> => {
  await useTenant(db, tenant);

  const rows = await db.execute(sql`
    insert into products
      (tenant_id, sku, name, wine_type, price_cents, currency, stock_status, status)
    values (
      ${tenant}::uuid, ${`sku-${randomUUID()}`}, ${name}, 'red', 1000, 'EUR', 'IN_STOCK',
      ${status}::product_status
    )
    returning id
  `);
  const productId = ([...rows][0] as { id: string }).id;

  for (let chunk = 0; chunk < chunks; chunk += 1) {
    await db.execute(sql`
      insert into product_embeddings
        (tenant_id, product_id, chunk_idx, content_hash, embedding, model, version)
      values (
        ${tenant}::uuid, ${productId}::uuid, ${chunk}, ${`hash-${String(chunk)}`},
        ${JSON.stringify(vectorFor(index))}::halfvec, 'amazon.titan-embed-text-v2:0', ${version}
      )
    `);
  }

  return productId;
};

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
  tenantId = await createTenant(db, 'retrieval');
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const search = (tenant: string, limit?: number) =>
  withTenant(
    tenant,
    (tx) => vectorSearch(tx, { vector: QUERY, ...(limit === undefined ? {} : { limit }) }),
    db,
  );

describe('vector search', () => {
  it('returns the exact nearest wines, in order, against a hand-computed ranking', async () => {
    const expected: string[] = [];

    // Index 0 is the query itself; each next wine leans further off its axis.
    for (let index = 0; index < 6; index += 1) {
      expected.push(await addWine(tenantId, { name: `wine ${String(index)}`, index }));
    }

    const found = await search(tenantId);

    expect(found.map((candidate) => candidate.productId)).toEqual(expected);
    expect(found[0]?.distance).toBeLessThan(found[5]?.distance ?? 0);
  });

  it('returns no more than it was asked for, keeping the nearest', async () => {
    const found = await search(tenantId, 3);

    expect(found).toHaveLength(3);
    expect(found.map((candidate) => candidate.distance)).toEqual(
      [...found].map((candidate) => candidate.distance).sort((a, b) => a - b),
    );
  });

  it('offers a wine once, however many chunks it is stored as', async () => {
    // Several chunks of one bottle must not occupy several of the forty places.
    const chunked = await addWine(tenantId, { name: 'chunked', index: 0, chunks: 3 });

    const found = await search(tenantId);

    expect(found.filter((candidate) => candidate.productId === chunked)).toHaveLength(1);
  });

  it('never returns a wine that was archived', async () => {
    // P1-05's assertion, arriving through the function retrieval actually uses.
    const archived = await addWine(tenantId, { name: 'archived', index: 0, status: 'ARCHIVED' });

    const found = await search(tenantId);

    expect(found.map((candidate) => candidate.productId)).not.toContain(archived);
  });

  it('never returns a wine on a generation the tenant has moved off', async () => {
    // P1-49: mixing two generations ranks one model's distances against another's.
    const stale = await addWine(tenantId, { name: 'previous generation', index: 0, version: 2 });

    const found = await search(tenantId);

    expect(found.map((candidate) => candidate.productId)).not.toContain(stale);
  });

  it("returns none of another winery's wines", async () => {
    const other = await createTenant(db, 'retrieval-other');
    const theirs = await addWine(other, { name: 'theirs', index: 0 });

    const mine = await search(tenantId);
    const found = await search(other);

    expect(mine.map((candidate) => candidate.productId)).not.toContain(theirs);
    expect(found.map((candidate) => candidate.productId)).toEqual([theirs]);
  });
});
