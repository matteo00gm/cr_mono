import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  archiveProduct,
  insertProduct,
  reindexCatalogue,
  reindexProduct,
} from '../src/products.js';
import type { EmbeddingState } from '../src/products-read.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Reindex against real Postgres (P1-39).
 *
 * **This file exists for `reindexCatalogue`, which a fake cannot verify at
 * all.** It is one statement: a `CASE` over an enum column feeding a CTE that
 * feeds an `INSERT ... SELECT`. Every way it can be wrong is a way Postgres
 * decides rather than TypeScript — an enum cast Postgres refuses, a `WHERE`
 * that catches archived rows, a trigger that stamps `updated_at` on a bulk
 * update. The unit test beside this one covers the branches; this covers
 * whether the SQL does what the comment says.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  /*
   * **One connection, and it is not a performance choice.** `createTenant` sets
   * `app.tenant_id` at *session* level and then inserts the row the GUC names —
   * two statements that must reach the same backend. With a pool of two, once
   * both connections are live either statement can land on either one, and the
   * insert is rejected by the `tenants` policy for a reason that looks nothing
   * like a pool: "new row violates row-level security policy". Seen here on
   * five of eleven tests before this line.
   */
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'reindex');
  otherTenantId = await createTenant(db, 'reindex-other');
});

const inTenant = <T>(tenant: string, run: (tx: DbTransaction) => Promise<T>): Promise<T> =>
  db.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
    return run(tx);
  });

const product = (index: number) => ({
  sku: `SKU-${String(index).padStart(3, '0')}`,
  name: `Wine ${String(index).padStart(3, '0')}`,
  wineType: 'red',
  priceCents: 1000 + index,
  currency: 'EUR',
  stockStatus: 'IN_STOCK' as const,
});

/** The `queued` edge as `packages/core` defines it. Copied here because this package cannot import it. */
const QUEUED_EDGES: Readonly<Record<EmbeddingState, EmbeddingState>> = {
  PENDING: 'PENDING',
  INDEXED: 'STALE',
  FAILED: 'PENDING',
  STALE: 'PENDING',
};

const seed = async (
  tenant: string,
  count: number,
): Promise<{ ids: string[]; setState: (id: string, state: EmbeddingState) => Promise<void> }> => {
  const ids = await inTenant(tenant, async (tx) => {
    const created: string[] = [];

    for (let index = 0; index < count; index += 1) {
      const result = await insertProduct(tx, {
        tenantId: tenant,
        values: product(index),
        contentHash: `hash-${String(index)}`,
      });

      if (result.outcome !== 'created') throw new Error('seed failed');
      created.push(result.product.id);
    }

    return created;
  });

  return {
    ids,
    setState: (id, state) =>
      inTenant(tenant, async (tx) => {
        await tx.execute(
          sql`update products set embedding_state = ${state}::product_embedding_state,
                                  embedding_error = 'the provider timed out',
                                  embedding_attempts = 3
               where id = ${id}::uuid`,
        );
      }),
  };
};

/** Marks every queued job published, so the in-flight guard stops refusing. */
const drainQueue = () =>
  inTenant(tenantId, async (tx) => {
    await tx.execute(sql`update outbox set processed_at = now() where processed_at is null`);
  });

const stateOf = (id: string) =>
  inTenant(tenantId, async (tx) => {
    const rows = await tx.execute(
      sql`select embedding_state, embedding_error, embedding_attempts,
                 extract(epoch from updated_at)::double precision as updated
            from products where id = ${id}::uuid`,
    );

    return [...rows][0] as {
      embedding_state: EmbeddingState;
      embedding_error: string | null;
      embedding_attempts: number;
      updated: number;
    };
  });

const queuedJobs = (tenant: string) =>
  inTenant(tenant, async (tx) => {
    const rows = await tx.execute(
      sql`select aggregate_id, payload from outbox
           where processed_at is null and event_type = 'product.embed'
           order by id`,
    );

    return [...rows] as { aggregate_id: string; payload: { reason?: string; batchId?: string } }[];
  });

describe('reindexCatalogue', () => {
  it('queues one job per active wine and reports how many', async () => {
    const { ids } = await seed(tenantId, 4);
    await drainQueue();

    const result = await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, {
        edges: QUEUED_EDGES,
        batchId: 'batch-1',
        reason: 'manual-reindex-all',
      }),
    );

    expect(result).toEqual({ outcome: 'queued', batchId: 'batch-1', queued: 4 });
    expect((await queuedJobs(tenantId)).map((job) => job.aggregate_id).sort()).toEqual(
      [...ids].sort(),
    );
  });

  it('stamps the batch id on every row it wrote', async () => {
    // The one thing the id is for: telling this run's rows from another's when
    // reading the queue. A batch id on the response and not on the rows would
    // be a field that looks like a handle and is not.
    await seed(tenantId, 2);
    await drainQueue();

    await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, {
        edges: QUEUED_EDGES,
        batchId: 'batch-7',
        reason: 'manual-reindex-all',
      }),
    );

    for (const job of await queuedJobs(tenantId)) {
      expect(job.payload).toEqual({ reason: 'manual-reindex-all', batchId: 'batch-7' });
    }
  });

  it('applies the transition table, state by state', async () => {
    /*
     * **The assertion the `CASE` exists for.** Each state moves where
     * `packages/core` says it moves, and the two that matter are the two that
     * differ: an `INDEXED` wine becomes `STALE` — still findable under its
     * previous description — while a `FAILED` one returns to `PENDING`.
     * Collapsing them would tell a seller their catalogue had gone dark during
     * a reindex.
     */
    const { ids, setState } = await seed(tenantId, 4);
    const [pending, indexed, failed, stale] = ids as [string, string, string, string];

    await setState(indexed, 'INDEXED');
    await setState(failed, 'FAILED');
    await setState(stale, 'STALE');
    await drainQueue();

    await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b', reason: 'manual-reindex-all' }),
    );

    expect((await stateOf(pending)).embedding_state).toBe('PENDING');
    expect((await stateOf(indexed)).embedding_state).toBe('STALE');
    expect((await stateOf(failed)).embedding_state).toBe('PENDING');
    expect((await stateOf(stale)).embedding_state).toBe('PENDING');
  });

  it('clears the error and keeps the attempt count', async () => {
    /*
     * Opposite reasons, and both are in `nextEmbeddingStatus`'s docstring. A
     * row carrying last week's failure while it is being retried tells an
     * operator a wine is broken when it is not. The attempt count survives
     * because a wine that needed four tries is worth knowing about afterwards —
     * four tries usually means a text the provider keeps struggling with.
     */
    const { ids, setState } = await seed(tenantId, 1);
    const [only] = ids as [string];

    await setState(only, 'FAILED');
    await drainQueue();

    await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b', reason: 'manual-reindex-all' }),
    );

    const after = await stateOf(only);

    expect(after.embedding_error).toBeNull();
    expect(after.embedding_attempts).toBe(3);
  });

  it('does not move updated_at', async () => {
    /*
     * **The failure migration 0038 was written for, asserted through the bulk
     * path that would cause it.** `updated_at` is what P1-06 sorts "recently
     * edited" by, and a seller reads that as a record of their own work. A
     * reindex touching every row would put the whole catalogue at the top of it
     * and there would be nothing on any row to explain why.
     */
    const { ids } = await seed(tenantId, 2);
    await drainQueue();

    const before = await Promise.all(ids.map((id) => stateOf(id)));

    await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b', reason: 'manual-reindex-all' }),
    );

    const after = await Promise.all(ids.map((id) => stateOf(id)));

    expect(after.map((row) => row.updated)).toEqual(before.map((row) => row.updated));
  });

  it('leaves archived wines alone', async () => {
    /*
     * Re-embedding an archived wine would put it back in front of visitors,
     * which is precisely what archiving means to stop — and the seller would
     * have no way to tell it had happened.
     */
    const { ids } = await seed(tenantId, 3);
    const [archived] = ids as [string, string, string];

    await inTenant(tenantId, (tx) => archiveProduct(tx, archived));
    await drainQueue();

    const result = await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b', reason: 'manual-reindex-all' }),
    );

    expect(result).toEqual({ outcome: 'queued', batchId: 'b', queued: 2 });
    expect((await queuedJobs(tenantId)).map((job) => job.aggregate_id)).not.toContain(archived);
  });

  it('refuses a second run while the first is still draining', async () => {
    // The row's "a second concurrent reindex-all is rejected", reached through
    // the condition that matters: work already in the queue.
    await seed(tenantId, 3);
    await drainQueue();

    const first = await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b1', reason: 'manual-reindex-all' }),
    );
    const second = await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b2', reason: 'manual-reindex-all' }),
    );

    expect(first.outcome).toBe('queued');
    expect(second).toEqual({ outcome: 'in-flight', queued: 3 });
    expect(await queuedJobs(tenantId)).toHaveLength(3);
  });

  it('is not blocked by another winery queue, and does not touch its rows', async () => {
    /*
     * **Both halves are the policy, not a predicate.** The in-flight guard
     * counts under RLS, so a busy neighbour cannot stop this seller from
     * reindexing — a shared counter would be a cross-tenant denial of service
     * that nothing in the code would look like. And the bulk `UPDATE` has no
     * tenant clause at all: it is scoped the same way, which is the arrangement
     * that cannot be forgotten in a later edit.
     */
    const theirs = await seed(otherTenantId, 2);
    const mine = await seed(tenantId, 2);
    await drainQueue();

    const result = await inTenant(tenantId, (tx) =>
      reindexCatalogue(tx, { edges: QUEUED_EDGES, batchId: 'b', reason: 'manual-reindex-all' }),
    );

    expect(result).toEqual({ outcome: 'queued', batchId: 'b', queued: 2 });

    const theirJobs = await queuedJobs(otherTenantId);

    expect(theirJobs.map((job) => job.aggregate_id).sort()).toEqual([...theirs.ids].sort());
    expect(theirJobs.every((job) => job.payload.batchId === undefined)).toBe(true);
    expect(mine.ids).toHaveLength(2);
  });
});

describe('reindexProduct', () => {
  it('queues one job and moves only that wine', async () => {
    const { ids, setState } = await seed(tenantId, 2);
    const [first, second] = ids as [string, string];

    await setState(first, 'INDEXED');
    await setState(second, 'INDEXED');
    await drainQueue();

    const result = await inTenant(tenantId, (tx) =>
      reindexProduct(tx, {
        productId: first,
        nextStatus: (current) => ({
          state: QUEUED_EDGES[current.state],
          error: null,
          attempts: current.attempts,
        }),
        reason: 'manual-reindex',
      }),
    );

    expect(result.outcome).toBe('queued');
    expect((await stateOf(first)).embedding_state).toBe('STALE');
    expect((await stateOf(second)).embedding_state).toBe('INDEXED');
    expect((await queuedJobs(tenantId)).map((job) => job.aggregate_id)).toEqual([first]);
  });

  it('reports not-found for another winery id, without comparing tenants', async () => {
    /*
     * §3.5's 404. The row exists; this transaction cannot see it, so the
     * statement matches nothing — reached through the policy rather than
     * through a branch anybody could write the other way round.
     */
    const theirs = await seed(otherTenantId, 1);
    const [id] = theirs.ids as [string];

    const result = await inTenant(tenantId, (tx) =>
      reindexProduct(tx, {
        productId: id,
        nextStatus: (current) => ({ state: 'PENDING', error: null, attempts: current.attempts }),
        reason: 'manual-reindex',
      }),
    );

    expect(result).toEqual({ outcome: 'not-found' });
  });

  it('commits the state and the job together, or neither', async () => {
    /*
     * §4.1 for this path. A state moved to `STALE` with no job queued is a wine
     * that stays stale for ever, with nothing anywhere saying so — the same
     * failure the outbox exists to prevent on the create path.
     */
    const { ids, setState } = await seed(tenantId, 1);
    const [only] = ids as [string];

    await setState(only, 'INDEXED');
    await drainQueue();

    await expect(
      inTenant(tenantId, async (tx) => {
        await reindexProduct(tx, {
          productId: only,
          nextStatus: (current) => ({ state: 'STALE', error: null, attempts: current.attempts }),
          reason: 'manual-reindex',
        });

        throw new Error('rolled back');
      }),
    ).rejects.toThrow('rolled back');

    expect((await stateOf(only)).embedding_state).toBe('INDEXED');
    expect(await queuedJobs(tenantId)).toHaveLength(0);
  });
});
