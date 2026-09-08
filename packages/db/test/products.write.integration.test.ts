import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { archiveProduct, enqueueEmbedding, insertProduct, updateProduct } from '../src/products.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The catalogue write path against real Postgres (P1-02).
 *
 * **The pairing is what this file exists for.** A committed product must always
 * have a queued embedding job (§4.1): a product without one is invisible to
 * search, and the seller sees a catalogue that silently lacks it — no error, no
 * failed job, nothing to retry. A fake transaction cannot demonstrate that,
 * because it rolls back nothing; only a real one can show that a failure after
 * the insert leaves *neither* row.
 *
 * It connects as `app_rw`, the role the API runs as, so the RLS policies and
 * the P0-33a grants are in force rather than assumed.
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
  tenantId = await createTenant(db, 'catalog');
});

const VALUES = {
  sku: 'BAR-2019',
  name: 'Barolo Bussia',
  wineType: 'red',
  priceCents: 4500,
  currency: 'EUR',
  stockStatus: 'IN_STOCK',
} as const;

/**
 * Runs inside a transaction with the tenant GUC set the way `withTenant` sets
 * it — `SET LOCAL`, so the scope ends with the transaction.
 *
 * Written out rather than calling `withTenant` because that helper opens its
 * own connection from the pool, and these tests need to drive a specific
 * client. The GUC statement is the same one, which is the part that matters:
 * a test that set the context differently would be testing a context
 * production never has.
 */
const inTenant = <T>(run: (tx: DbTransaction) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenantId}, true)`);
    return run(tx);
  });

const productCount = async (): Promise<number> => {
  const rows = await db.execute(sql`select count(*)::int as n from products`);
  return ([...rows][0] as { n: number }).n;
};

const jobCount = async (): Promise<number> => {
  const rows = await db.execute(sql`select count(*)::int as n from outbox`);
  return ([...rows][0] as { n: number }).n;
};

describe('insertProduct', () => {
  it('stores the product and returns it as written', async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'hash-1' }),
    );

    expect(result.outcome).toBe('created');
    if (result.outcome !== 'created') return;

    expect(result.product).toMatchObject({
      sku: 'BAR-2019',
      tenantId,
      status: 'ACTIVE',
      embeddingState: 'PENDING',
      contentHash: 'hash-1',
    });
    /*
     * The server-owned columns are populated, which is why the route returns
     * the row rather than an id — a client would otherwise have to re-fetch to
     * learn them.
     */
    expect(result.product.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(result.product.createdAt).toBeInstanceOf(Date);
  });

  it('queues exactly one embedding job for it', async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'hash-1' }),
    );

    if (result.outcome !== 'created') throw new Error('expected a created product');

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select event_type, payload, processed_at from outbox where aggregate_id = ${result.product.id}::uuid`,
    );
    const job = [...rows][0] as { event_type: string; payload: unknown; processed_at: unknown };

    expect(job.event_type).toBe('product.embed');
    expect(job.payload).toEqual({ reason: 'created' });
    // Unprocessed: the queue of work *is* the set of nulls (P0-36).
    expect(job.processed_at).toBeNull();
  });

  it('leaves neither row when the transaction fails after the insert', async () => {
    /*
     * **The assertion the whole design is for.** A product that committed
     * without its job is invisible to search with nothing to retry; a job that
     * committed without its product points at nothing. The only way to have
     * neither is one transaction, and the only way to prove it is a real one.
     */
    const before = { products: await productCount(), jobs: await jobCount() };

    await expect(
      inTenant(async (tx) => {
        await insertProduct(tx, { tenantId, values: VALUES, contentHash: 'hash-1' });
        throw new Error('something failed after the write');
      }),
    ).rejects.toThrow('something failed after the write');

    await useTenant(db, tenantId);
    expect(await productCount()).toBe(before.products);
    expect(await jobCount()).toBe(before.jobs);
  });

  it('reports a duplicate SKU as an outcome rather than throwing', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    const second = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }),
    );

    /*
     * An outcome, not an exception, for the reason P0-52 gives: what a refusal
     * means to a caller is HTTP-shaped, and this package has no HTTP. A thrown
     * error would have to be caught and re-classified by every caller, which is
     * where one of them eventually returns a 500 for a form mistake.
     */
    expect(second).toEqual({ outcome: 'duplicate-sku' });
  });

  it('queues no job for a refused duplicate', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    await useTenant(db, tenantId);
    const before = await jobCount();

    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    /*
     * The other half of the pairing, and the one an implementation could get
     * wrong while passing everything above: enqueueing for a row that was never
     * created gives the worker a job whose product does not exist.
     */
    await useTenant(db, tenantId);
    expect(await jobCount()).toBe(before);
  });

  it('lets two wineries use the same SKU, because uniqueness is per tenant', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    const other = await createTenant(db, 'other-winery');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return insertProduct(tx, { tenantId: other, values: VALUES, contentHash: 'h' });
    });

    expect(result.outcome).toBe('created');
  });

  it('writes the tenant from the argument, not from the values', async () => {
    /*
     * P0-48 at the storage layer. `productInsert` omits the column so a body
     * cannot carry one, and this proves the statement does not read one either
     * — a spread that happened to include `tenantId` would otherwise be written
     * verbatim and rejected only by the RLS `WITH CHECK`, which is a 500 rather
     * than a refusal anyone can act on.
     */
    const result = await inTenant((tx) =>
      insertProduct(tx, {
        tenantId,
        // Cast because the type refuses it — which is P0-48's guarantee, and
        // exactly what this asserts the statement also ignores at runtime.
        values: { ...VALUES, tenantId: '99999999-9999-9999-9999-999999999999' } as never,
        contentHash: 'h',
      }),
    );

    if (result.outcome !== 'created') throw new Error('expected a created product');
    expect(result.product.tenantId).toBe(tenantId);
  });
});

describe('enqueueEmbedding', () => {
  it('records the reason, so a triage can tell a create from a reindex', async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }),
    );
    if (result.outcome !== 'created') throw new Error('expected a created product');

    await inTenant((tx) =>
      enqueueEmbedding(tx, { tenantId, productId: result.product.id, reason: 'reindex' }),
    );

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select payload from outbox where aggregate_id = ${result.product.id}::uuid order by id`,
    );

    expect([...rows].map((row) => (row as { payload: { reason: string } }).payload.reason)).toEqual(
      ['created', 'reindex'],
    );
  });
});

describe('RLS, which the route depends on and never checks', () => {
  it('hides one winery catalogue from another', async () => {
    await inTenant((tx) => insertProduct(tx, { tenantId, values: VALUES, contentHash: 'h' }));

    const other = await createTenant(db, 'nosy-winery');
    await useTenant(db, other);

    /*
     * The route reads `tenantId` from a membership row and passes it to
     * `withTenant`; nothing in `apps/api` re-checks that a returned row belongs
     * to that tenant, because the policy is what guarantees it. Asserting the
     * policy here is what makes that omission safe rather than lucky.
     */
    expect(await productCount()).toBe(0);
  });
});

/**
 * A stand-in for `contentHashOf`, and deliberately not the real one.
 *
 * `packages/db` cannot import `packages/core` — core depends on db, so the
 * boundary rules forbid the cycle. That constraint is a good one here: what
 * `updateProduct` promises is *call the injected rule and compare against the
 * stored hash*, and which fields the real rule covers is a domain decision with
 * its own tests in `packages/core/test/catalog`. Using the real function would
 * couple these assertions to a field list they have no business pinning.
 *
 * So this covers the sommelier fields and ignores price and stock, which is
 * enough to exercise both branches.
 */
interface Hashable {
  readonly name?: string | null | undefined;
  readonly tastingNotes?: string | null | undefined;
  readonly region?: string | null | undefined;
  readonly wineType?: string | null | undefined;
}

const testHash = (row: Hashable): string =>
  JSON.stringify([row.name, row.tastingNotes, row.region, row.wineType]);

describe('updateProduct', () => {
  /** Seeds a product and returns it, hashed the way the route would. */
  const seed = async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: testHash(VALUES) }),
    );
    if (result.outcome !== 'created') throw new Error('expected a created product');
    return result.product;
  };

  const patch = (productId: string, values: Record<string, unknown>) =>
    inTenant((tx) =>
      updateProduct(tx, {
        productId,
        values: values,
        hashOf: (merged) => testHash(merged),
      }),
    );

  it('applies the patch and leaves everything else alone', async () => {
    const product = await seed();

    const result = await patch(product.id, { priceCents: 4900 });

    expect(result.outcome).toBe('updated');
    if (result.outcome !== 'updated') return;

    expect(result.product.priceCents).toBe(4900);
    /*
     * The fields the patch did not mention. A merge that spread `undefined`
     * over the row would blank every one of them, and the damage would show in
     * the hash before it showed in the data.
     */
    expect(result.product.name).toBe(VALUES.name);
    expect(result.product.sku).toBe(VALUES.sku);
  });

  it('queues nothing when the change is invisible to the model', async () => {
    /*
     * **The row's whole point, and the only place it can be proved.** A seller
     * correcting stock or fixing a price edits rows constantly; embedding every
     * one of those is a bill that tracks how often people use the product
     * rather than what is in it.
     */
    const product = await seed();
    await useTenant(db, tenantId);
    const before = await jobCount();

    const result = await patch(product.id, { priceCents: 9900, stockQty: 3 });

    expect(result).toMatchObject({ outcome: 'updated', reindexed: false });

    await useTenant(db, tenantId);
    expect(await jobCount()).toBe(before);
  });

  it('leaves the embedding state alone when nothing was re-embedded', async () => {
    const product = await seed();

    // Pretend the worker finished, which is the state a real catalogue is in.
    await useTenant(db, tenantId);
    await db.execute(
      sql`update products set embedding_state = 'INDEXED' where id = ${product.id}::uuid`,
    );

    const result = await patch(product.id, { priceCents: 1234 });

    if (result.outcome !== 'updated') throw new Error('expected an update');
    /*
     * A price edit must not make a wine look unindexed. Setting `STALE`
     * unconditionally would be the easy implementation and would tell every
     * seller their catalogue needed rebuilding after every price change.
     */
    expect(result.product.embeddingState).toBe('INDEXED');
  });

  it('queues exactly one job when the change reaches the model', async () => {
    const product = await seed();
    await useTenant(db, tenantId);
    const before = await jobCount();

    const result = await patch(product.id, { tastingNotes: 'Completely different notes.' });

    expect(result).toMatchObject({ outcome: 'updated', reindexed: true });

    await useTenant(db, tenantId);
    expect(await jobCount()).toBe(before + 1);

    const rows = await db.execute(
      sql`select payload from outbox where aggregate_id = ${product.id}::uuid order by id desc limit 1`,
    );
    expect(([...rows][0] as { payload: { reason: string } }).payload).toEqual({
      reason: 'updated',
    });
  });

  it('marks a re-embedded row STALE rather than PENDING', async () => {
    const product = await seed();
    await useTenant(db, tenantId);
    await db.execute(
      sql`update products set embedding_state = 'INDEXED' where id = ${product.id}::uuid`,
    );

    const result = await patch(product.id, { region: 'Toscana' });

    if (result.outcome !== 'updated') throw new Error('expected an update');
    /*
     * The distinction P1-40's grid shows a seller. `PENDING` means this wine
     * has never been indexed and cannot be recommended yet; `STALE` means it is
     * findable under its previous description while the new one is built.
     * Collapsing them would tell somebody their catalogue had gone dark during
     * an ordinary edit.
     */
    expect(result.product.embeddingState).toBe('STALE');
  });

  it('stores the new hash, so the next identical edit costs nothing', async () => {
    const product = await seed();

    await patch(product.id, { region: 'Toscana' });
    const second = await patch(product.id, { region: 'Toscana' });

    expect(second).toMatchObject({ reindexed: false });
  });

  it('leaves neither the row nor a job when the transaction fails afterwards', async () => {
    const product = await seed();
    await useTenant(db, tenantId);
    const before = await jobCount();

    await expect(
      inTenant(async (tx) => {
        await updateProduct(tx, {
          productId: product.id,
          values: { tastingNotes: 'New notes.' },
          hashOf: (merged) => testHash(merged),
        });
        throw new Error('something failed after the update');
      }),
    ).rejects.toThrow('something failed after the update');

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select tasting_notes from products where id = ${product.id}::uuid`,
    );

    expect(([...rows][0] as { tasting_notes: string | null }).tasting_notes).toBeNull();
    expect(await jobCount()).toBe(before);
  });

  it('answers not-found for another winery product, without a tenant check', async () => {
    /*
     * **§3.5 falls out of RLS rather than being coded.** Nothing here compares
     * the row's tenant to the caller's — the read simply matches nothing under
     * the other winery policy. The natural hand-written version returns 403,
     * which tells an attacker the resource exists.
     */
    const product = await seed();

    const other = await createTenant(db, 'nosy-winery');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return updateProduct(tx, {
        productId: product.id,
        values: { priceCents: 1 },
        hashOf: () => 'irrelevant',
      });
    });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('reports a SKU collision as an outcome', async () => {
    await seed();
    const second = await inTenant((tx) =>
      insertProduct(tx, {
        tenantId,
        values: { ...VALUES, sku: 'OTHER-2020' },
        contentHash: testHash(VALUES),
      }),
    );
    if (second.outcome !== 'created') throw new Error('expected a created product');

    expect(await patch(second.product.id, { sku: VALUES.sku })).toEqual({
      outcome: 'duplicate-sku',
    });
  });
});

describe('archiveProduct', () => {
  const seed = async () => {
    const result = await inTenant((tx) =>
      insertProduct(tx, { tenantId, values: VALUES, contentHash: testHash(VALUES) }),
    );
    if (result.outcome !== 'created') throw new Error('expected a created product');
    return result.product;
  };

  /** A vector for a product, written the way the worker will (P1-37). */
  const indexProduct = async (productId: string) => {
    await useTenant(db, tenantId);
    await db.execute(sql`
      insert into product_embeddings (tenant_id, product_id, chunk_idx, content_hash, embedding, model)
      values (
        ${tenantId}::uuid, ${productId}::uuid, 0, 'hash',
        ${`[${Array.from({ length: 1024 }, () => '0').join(',')}]`}::halfvec(1024),
        'amazon.titan-embed-text-v2:0'
      )
    `);
  };

  const vectorCount = async (productId: string): Promise<number> => {
    const rows = await db.execute(
      sql`select count(*)::int as n from product_embeddings where product_id = ${productId}::uuid`,
    );
    return ([...rows][0] as { n: number }).n;
  };

  it('archives the row rather than deleting it', async () => {
    const product = await seed();

    const result = await inTenant((tx) => archiveProduct(tx, product.id));

    expect(result).toMatchObject({ outcome: 'archived' });

    /*
     * **The row survives, and that is the point of the soft delete.** An order
     * placed last month refers to it, and a catalogue that forgets what it sold
     * cannot answer a customer's question about their own purchase.
     */
    await useTenant(db, tenantId);
    const rows = await db.execute(sql`select status from products where id = ${product.id}::uuid`);
    expect(([...rows][0] as { status: string }).status).toBe('ARCHIVED');
  });

  it('deletes the vectors outright, which the cascade would not do', async () => {
    /*
     * **`ON DELETE CASCADE` does not help here**, and this is the assertion
     * that proves the explicit delete is doing the work: the cascade fires when
     * the *product row* goes, and this path deliberately keeps it. A reader who
     * knows the cascade exists is exactly the reader who would assume this was
     * handled — and the symptom of the assumption is a removed wine that keeps
     * being recommended.
     */
    const product = await seed();
    await indexProduct(product.id);

    await useTenant(db, tenantId);
    expect(await vectorCount(product.id)).toBe(1);

    const result = await inTenant((tx) => archiveProduct(tx, product.id));

    expect(result).toMatchObject({ vectorsRemoved: 1 });
    await useTenant(db, tenantId);
    expect(await vectorCount(product.id)).toBe(0);
  });

  it('is idempotent, because a repeated click is not a conflict', async () => {
    const product = await seed();
    await indexProduct(product.id);

    await inTenant((tx) => archiveProduct(tx, product.id));
    const second = await inTenant((tx) => archiveProduct(tx, product.id));

    expect(second).toMatchObject({ outcome: 'archived', vectorsRemoved: 0 });
  });

  it('leaves both halves alone when the transaction fails afterwards', async () => {
    const product = await seed();
    await indexProduct(product.id);

    await expect(
      inTenant(async (tx) => {
        await archiveProduct(tx, product.id);
        throw new Error('something failed after archiving');
      }),
    ).rejects.toThrow('something failed after archiving');

    /*
     * Both, and the vector half is the one that matters: an archive that
     * committed the row while rolling back the delete would leave a wine that
     * is hidden from the seller and still recommended to visitors.
     */
    await useTenant(db, tenantId);
    const rows = await db.execute(sql`select status from products where id = ${product.id}::uuid`);
    expect(([...rows][0] as { status: string }).status).toBe('ACTIVE');
    expect(await vectorCount(product.id)).toBe(1);
  });

  it('answers not-found for another winery product', async () => {
    const product = await seed();

    const other = await createTenant(db, 'nosy-winery');
    const result = await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return archiveProduct(tx, product.id);
    });

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('does not touch another winery vectors for the same id', async () => {
    /*
     * Belt and braces on the delete: the `where` clause names only the product
     * id, so a policy that admitted more rows would let one tenant clear
     * another's index. RLS is what stops it, and this is the assertion that
     * RLS is in fact what is stopping it.
     */
    const product = await seed();
    await indexProduct(product.id);

    const other = await createTenant(db, 'other-winery');
    await db.transaction(async (tx) => {
      await tx.execute(sql`select set_config('app.tenant_id', ${other}, true)`);
      return archiveProduct(tx, product.id);
    });

    await useTenant(db, tenantId);
    expect(await vectorCount(product.id)).toBe(1);
  });
});
