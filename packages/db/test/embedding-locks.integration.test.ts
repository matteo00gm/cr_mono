import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import type { ProductInsert } from '../src/contracts.js';
import { readProductForEmbedding, switchEmbeddingVersion } from '../src/embeddings.js';
import { insertProduct } from '../src/products.js';
import { withTenant } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The two embedding locks, each held to what it is for (review).
 *
 * **A mutation run removed each lock and no test failed.** Both are commented
 * with the race they prevent, and both races are real — but a lock nothing can
 * see removed is a comment, not a guard. These tests make the race happen: the
 * first transaction takes its lock and is held open on its own connection, the
 * second is started on another, and the assertion is that the second waits and
 * then sees what the first wrote. Without the lock it does neither.
 *
 * **A dedicated two-connection pool, and a signal rather than a sleep for the
 * first lock.** P4-08 found both ways a race test passes vacuously: a pool of
 * one cannot run two transactions at once, and a second transaction started
 * "after a while" may start before the first has locked anything.
 */

let container: StartedPostgreSqlContainer | undefined;
let seeding: DbClient | undefined;
let racing: DbClient | undefined;
let seedDb: Database;
let raceDb: Database;
let tenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  seeding = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  racing = createDbClient(started.roleUrl('app_rw'), { max: 2 });
  seedDb = seeding.db;
  raceDb = racing.db;
}, 180_000);

afterAll(async () => {
  await seeding?.close();
  await racing?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(seedDb, 'locks');
});

/** A promise and the function that settles it. */
const deferred = () => {
  let resolve: () => void = () => undefined;
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
};

/** How long a transaction that should be blocked gets to prove it is not. */
const BLOCKED_FOR_MS = 400;

const settled = <T>(promise: Promise<T>) => {
  const state = { done: false };
  void promise.then(
    () => {
      state.done = true;
    },
    () => {
      state.done = true;
    },
  );
  return state;
};

const pause = (ms: number) =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const addWine = async (sku: string): Promise<string> => {
  const values = {
    sku,
    name: `Vino ${sku}`,
    wineType: 'red',
    priceCents: 2500,
    currency: 'EUR',
    stockStatus: 'IN_STOCK',
  } as ProductInsert;

  const created = await withTenant(
    tenantId,
    (tx) => insertProduct(tx, { tenantId, values, contentHash: `hash-${sku}` }),
    seedDb,
  );
  if (created.outcome !== 'created') throw new Error('seed failed');
  return created.product.id;
};

describe('two deliveries of one embedding message', () => {
  it('the second waits for the first, then sees the product it indexed', async () => {
    /*
     * Without the lock both read PENDING, both embed and both write — the
     * provider is paid twice and the state column is raced.
     */
    const productId = await addWine('LOCK-EMBED');
    const locked = deferred();
    const release = deferred();

    const first = withTenant(
      tenantId,
      async (tx) => {
        await readProductForEmbedding(tx, productId);
        locked.resolve();
        await release.promise;
        await tx.execute(sql`
          UPDATE products SET embedding_state = 'INDEXED' WHERE id = ${productId}::uuid
        `);
      },
      raceDb,
    );

    await locked.promise;

    const second = withTenant(tenantId, (tx) => readProductForEmbedding(tx, productId), raceDb);
    const state = settled(second);

    await pause(BLOCKED_FOR_MS);
    expect(state.done).toBe(false);

    release.resolve();
    await first;

    expect((await second)?.embeddingState).toBe('INDEXED');
  });
});

describe('two switches of one tenant’s embedding version', () => {
  it('the second waits for the first, then switches from where the first left it', async () => {
    /*
     * Without the lock the second reads the version from before the first and
     * reports switching from it — each passing the completeness count on its
     * own snapshot, and the record of what changed wrong about the start.
     */
    const locked = deferred();
    const release = deferred();

    const first = withTenant(
      tenantId,
      async (tx) => {
        const result = await switchEmbeddingVersion(tx, { tenantId, version: 2 });
        locked.resolve();
        await release.promise;
        return result;
      },
      raceDb,
    );

    await locked.promise;

    const second = withTenant(
      tenantId,
      (tx) => switchEmbeddingVersion(tx, { tenantId, version: 3 }),
      raceDb,
    );
    const state = settled(second);

    await pause(BLOCKED_FOR_MS);
    expect(state.done).toBe(false);

    release.resolve();

    expect(await first).toEqual({ outcome: 'switched', from: 1, to: 2 });
    expect(await second).toEqual({ outcome: 'switched', from: 2, to: 3 });
  });
});
