import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  EMBEDDING_CHUNK,
  readProductForEmbedding,
  upsertEmbedding,
  writeEmbeddingStatus,
} from '../src/embeddings.js';
import { insertProduct } from '../src/products.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { ProductInsert } from '../src/contracts.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The embedding read and write, against real Postgres (P1-37).
 *
 * **Three things live here because nothing else can show them**: that a job
 * naming the wrong tenant matches no product, that the vector and the state
 * commit together or not at all, and that the upsert replaces a wine's vector
 * rather than appending a second one. The first is a policy, the second a
 * transaction and the third a unique constraint — a fake has none of them.
 *
 * The decision tree around these calls is in `apps/worker/test/embed.test.ts`.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;
let productId: string;

const VALUES = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
  tastingNotes: 'Rosa appassita, catrame e ciliegia sotto spirito.',
  foodPairings: ['brasato'],
} as ProductInsert;

const vector = (fill: number) => Array.from({ length: 1024 }, () => fill);

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
  tenantId = await createTenant(db, 'embed');
  otherTenantId = await createTenant(db, 'embed-other');

  const created = await withTenant(
    tenantId,
    (tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'written-at-edit-time' }),
    db,
  );

  if (created.outcome !== 'created') throw new Error('seed failed');
  productId = created.product.id;
});

describe('reading a product for embedding', () => {
  it('finds nothing when the message names the wrong tenant', async () => {
    /*
     * **The tenant check the P1-37 row asks for, and it is structural rather
     * than an equality comparison.** The worker opens the transaction with the
     * tenant from the message; if that is not the wine's tenant, the policy
     * matches no row and the job reports `gone`. Comparing `row.tenant_id` to
     * the message afterwards would only restate what RLS already guaranteed —
     * and would be reading the answer from the same query it is meant to check.
     */
    const row = await withTenant(otherTenantId, (tx) => readProductForEmbedding(tx, productId), db);

    expect(row).toBeUndefined();
  });

  it('reports no embedded hash for a wine that has never been indexed', async () => {
    /*
     * `undefined`/null here is what makes `shouldEmbed` true, and the
     * distinction it draws is "never embedded" versus "unchanged". A product
     * that came back with a hash it had never been embedded under would be
     * skipped for ever.
     */
    const row = await withTenant(tenantId, (tx) => readProductForEmbedding(tx, productId), db);

    expect(row?.embeddedHash).toBeNull();
  });

  it('reports the hash stored beside the vector, not the one on the product', async () => {
    /*
     * **The subtlety this whole file exists around.** `products.content_hash`
     * was written by the insert above — `'written-at-edit-time'` — and it
     * already matches what an edit would compute. Feeding *that* to
     * `shouldEmbed` would make the worker skip every freshly created wine, and
     * report a clean pass doing it.
     */
    await withTenant(
      tenantId,
      (tx) =>
        upsertEmbedding(tx, {
          tenantId,
          productId,
          contentHash: 'built-the-vector-from-this',
          embedding: vector(0.1),
          model: 'amazon.titan-embed-text-v2:0',
        }),
      db,
    );

    const row = await withTenant(tenantId, (tx) => readProductForEmbedding(tx, productId), db);

    expect(row?.embeddedHash).toBe('built-the-vector-from-this');

    await useTenant(db, tenantId);
    const stored = await db.execute(
      sql`select content_hash from products where id = ${productId}::uuid`,
    );

    expect(String([...stored][0]?.content_hash)).toBe('written-at-edit-time');
  });

  it('hands back the fields the embedding text is built from', async () => {
    const row = await withTenant(tenantId, (tx) => readProductForEmbedding(tx, productId), db);

    expect(row).toMatchObject({
      name: 'Barolo Bussia',
      wineType: 'red',
      foodPairings: ['brasato'],
      priceCents: 4500,
      embeddingState: 'PENDING',
      embeddingAttempts: 0,
    });
  });
});

describe('storing the vector', () => {
  it('replaces a wine’s vector rather than adding a second one', async () => {
    /*
     * The schema comment's warning, made real: as an append this doubles a
     * product's vectors and skews every ranking it appears in. SQS redelivers
     * by design, so this path runs more than once for the same wine as a matter
     * of course rather than as an edge case.
     */
    for (const fill of [0.1, 0.2, 0.3]) {
      await withTenant(
        tenantId,
        (tx) =>
          upsertEmbedding(tx, {
            tenantId,
            productId,
            contentHash: `hash-${String(fill)}`,
            embedding: vector(fill),
            model: 'amazon.titan-embed-text-v2:0',
          }),
        db,
      );
    }

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`
      select chunk_idx, content_hash from product_embeddings where product_id = ${productId}::uuid
    `);

    expect([...rows]).toHaveLength(1);
    expect([...rows][0]).toMatchObject({ chunk_idx: EMBEDDING_CHUNK, content_hash: 'hash-0.3' });
  });

  it('stores a vector the similarity operator can actually read', async () => {
    // A 1024-element array has to arrive as a halfvec, not as a JSON string in
    // a text column — the driver mapping is the part that can silently be wrong.
    await withTenant(
      tenantId,
      (tx) =>
        upsertEmbedding(tx, {
          tenantId,
          productId,
          contentHash: 'h',
          embedding: vector(0.5),
          model: 'm',
        }),
      db,
    );

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`
      select vector_dims(embedding) as dims,
             embedding <=> embedding as self_distance
      from product_embeddings where product_id = ${productId}::uuid
    `);

    expect([...rows][0]).toMatchObject({ dims: 1024 });
    expect(Number([...rows][0]?.self_distance)).toBeCloseTo(0, 5);
  });
});

describe('the state and the vector', () => {
  it('commit together, or neither does', async () => {
    /*
     * **The guarantee that makes the state column trustworthy.** A vector
     * written without its state leaves a wine that is indexed and says it is
     * `PENDING` — harmless. A state written without its vector leaves one that
     * says `INDEXED` and cannot be found, which is invisible from the row and
     * is what P1-40's grid would report as healthy.
     */
    await expect(
      withTenant(
        tenantId,
        async (tx) => {
          await upsertEmbedding(tx, {
            tenantId,
            productId,
            contentHash: 'h',
            embedding: vector(0.5),
            model: 'm',
          });
          await writeEmbeddingStatus(tx, productId, {
            state: 'INDEXED',
            error: null,
            attempts: 0,
          });

          throw new Error('crash between the write and the commit');
        },
        db,
      ),
    ).rejects.toThrow('crash');

    await useTenant(db, tenantId);
    const vectors = await db.execute(
      sql`select 1 from product_embeddings where product_id = ${productId}::uuid`,
    );
    const state = await db.execute(
      sql`select embedding_state from products where id = ${productId}::uuid`,
    );

    expect([...vectors]).toHaveLength(0);
    expect([...state][0]).toMatchObject({ embedding_state: 'PENDING' });
  });

  it('records the reason and the attempt count on failure', async () => {
    await withTenant(
      tenantId,
      (tx) =>
        writeEmbeddingStatus(tx, productId, {
          state: 'FAILED',
          error: 'ThrottlingException',
          attempts: 1,
        }),
      db,
    );

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`
      select embedding_state, embedding_error, embedding_attempts
      from products where id = ${productId}::uuid
    `);

    expect([...rows][0]).toMatchObject({
      embedding_state: 'FAILED',
      embedding_error: 'ThrottlingException',
      embedding_attempts: 1,
    });
  });

  it('leaves updated_at alone, because a background job is not an edit', async () => {
    /*
     * `updated_at` means "when did the seller last change this wine". A
     * re-index moving it makes the catalogue's sort-by-recently-edited useless
     * the first time a bulk re-embed runs — and the seller has no way to tell
     * why every wine suddenly looks freshly touched.
     */
    await useTenant(db, tenantId);
    const before = await db.execute(
      sql`select updated_at from products where id = ${productId}::uuid`,
    );

    await withTenant(
      tenantId,
      (tx) => writeEmbeddingStatus(tx, productId, { state: 'INDEXED', error: null, attempts: 0 }),
      db,
    );

    await useTenant(db, tenantId);
    const after = await db.execute(
      sql`select updated_at from products where id = ${productId}::uuid`,
    );

    expect(String([...after][0]?.updated_at)).toBe(String([...before][0]?.updated_at));
  });
});
