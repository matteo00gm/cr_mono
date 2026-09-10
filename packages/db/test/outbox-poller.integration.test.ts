import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  claimOutboxJobs,
  countStuckJobs,
  markOutboxPublished,
  MAX_PUBLISH_ATTEMPTS,
  recordPublishFailure,
  runOutboxPass,
  type OutboxJob,
} from '../src/outbox.js';
import { withOutbox } from '../src/with-outbox.js';
import { startPostgres } from './support/postgres.js';
import { clearTenant, createTenant, useTenant } from './support/tenant.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * The poller's scope and its claim, against real Postgres (P1-31).
 *
 * **This file is the guard on the only policy branch in this repository that
 * widens rather than narrows.** `withOutbox` sets a GUC that lets a transaction
 * read every tenant's outbox rows, which is what draining one queue for the
 * whole platform requires and which nothing else here does. A unit test can
 * only check that the generated SQL says what was intended; whether Postgres
 * *enforces* it — that the flag is genuinely required to see anything, and that
 * it genuinely buys a read and not a write — is only answerable here.
 *
 * `SKIP LOCKED` is the other reason. Two pollers taking disjoint rows is a
 * property of the lock manager, and no amount of mocking demonstrates it.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let second: DbClient | undefined;
let admin: DbClient | undefined;
let db: Database;
let otherDb: Database;
let adminDb: Database;
let tenantId: string;
let otherTenantId: string;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;

  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;

  /*
   * A second connection, not a second pool slot. The concurrency test needs one
   * poller holding locks while another claims, and `max: 1` on a shared pool
   * would serialise them into passing for the wrong reason.
   */
  second = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  otherDb = second.db;

  /*
   * Admin, for two things app_rw deliberately cannot do: see across tenants
   * without the flag — so an assertion is never answered by the mechanism under
   * test — and empty the table between tests, since P1-31 revokes DELETE on
   * `outbox` from app_rw precisely so no application path can.
   */
  admin = createDbClient(started.adminUrl, { max: 1 });
  adminDb = admin.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await second?.close();
  await admin?.close();
  await container?.stop();
}, 60_000);

const seed = async (
  tenant: string,
  count: number,
  event = 'embedding.requested',
): Promise<void> => {
  await useTenant(db, tenant);

  for (let index = 0; index < count; index += 1) {
    await db.execute(sql`
      insert into outbox (tenant_id, aggregate_id, event_type, payload)
      values (${tenant}::uuid, gen_random_uuid(), ${event}, ${JSON.stringify({ reason: 'created' })}::jsonb)
    `);
  }
};

/** Every row, as only a role that bypasses RLS can see them. */
const allRows = async (): Promise<
  { tenant_id: string; attempts: number; processed: boolean }[]
> => {
  const rows = await adminDb.execute(
    sql`select tenant_id, attempts, processed_at is not null as processed from outbox order by id`,
  );

  return [...rows].map((row) => {
    const r = row as { tenant_id: string; attempts: string | number; processed: boolean };
    return { tenant_id: r.tenant_id, attempts: Number(r.attempts), processed: r.processed };
  });
};

beforeEach(async () => {
  /*
   * **Emptied between tests, and the reason is the subject of the file.** A
   * poller sees every tenant's rows, so rows left by an earlier test are not
   * invisible background noise here the way they are everywhere else — they
   * arrive in the next test's claim. CI found this the direct way: a claim
   * expecting two rows got seventeen.
   */
  await adminDb.execute(sql`delete from outbox`);

  tenantId = await createTenant(db, 'poller');
  otherTenantId = await createTenant(db, 'poller-other');

  await useTenant(db, tenantId);
});

describe('the flag is what unlocks the queue', () => {
  it('shows a poller every tenant, which is the whole point', async () => {
    await seed(tenantId, 2);
    await seed(otherTenantId, 3);
    await clearTenant(db);

    const claimed = await withOutbox((tx) => claimOutboxJobs(tx, 100), db);

    expect(claimed).toHaveLength(5);
    expect(new Set(claimed.map((job) => job.tenantId))).toEqual(new Set([tenantId, otherTenantId]));
  });

  it('shows a connection without it nothing at all', async () => {
    /*
     * **The guard, and it has to be able to fail.** Without the flag the
     * poller's query is an un-scoped read of a table under FORCE row-level
     * security, and it returns zero rows — quietly. A poller written without
     * `withOutbox` would not error; it would report a clean pass over an empty
     * queue, every minute, for ever, while the backlog grew behind it.
     */
    await seed(tenantId, 3);
    await clearTenant(db);

    const rows = await db.execute(sql`select id from outbox`);

    expect([...rows]).toHaveLength(0);
  });

  it('leaves an ordinary tenant seeing only its own rows', async () => {
    /*
     * The poller's branch was added to `tenant_isolation` rather than as a
     * second policy, so the risk is not that the new branch is too narrow — it
     * is that the tenant branch stops applying. A request that sets no flag
     * must still see one tenant's rows and no others.
     */
    await seed(tenantId, 2);
    await seed(otherTenantId, 4);
    await useTenant(db, otherTenantId);

    const rows = await db.execute(sql`select id from outbox`);

    expect([...rows]).toHaveLength(4);
  });
});

describe('what the flag does not buy', () => {
  it('cannot insert a job at all, let alone one naming another tenant', async () => {
    /*
     * **Why the flag is in `USING` and not in `WITH CHECK`.** An INSERT under
     * the flag would write an outbox row naming any tenant — a job pointing
     * into somebody else's catalogue, created by a path that never held that
     * tenant's context. The tenant branch is the only way to satisfy
     * `WITH CHECK`, and a poller that has not claimed anything has no tenant.
     *
     * The context is dropped first so the flag is the only thing in play; left
     * set, `tenant_isolation`'s tenant branch would decide the outcome and this
     * would pass whatever the poller branch said.
     */
    await clearTenant(db);

    await expect(
      withOutbox(
        (tx) =>
          tx.execute(sql`
            insert into outbox (tenant_id, aggregate_id, event_type)
            values (${otherTenantId}::uuid, gen_random_uuid(), 'forged')
          `),
        db,
      ),
    ).rejects.toThrow();

    expect(await allRows()).toEqual([]);
  });

  it('cannot delete a job, because the runtime role holds no DELETE at all', async () => {
    /*
     * **The one command the `WITH CHECK` argument does not cover.** A DELETE is
     * filtered by `USING` alone — there is no new row, so there is nothing for
     * `WITH CHECK` to refuse — and the poller's branch is in `USING`. Under the
     * flag, `delete from outbox` would therefore match every tenant's rows, and
     * one stray statement in a scheduled job would empty the platform's queue
     * silently: a drained queue and an erased one look identical from outside.
     *
     * Closed at the grant (migration 0037) rather than with a second policy,
     * which `rls-coverage.integration.test.ts` forbids and is right to. The
     * revoke is also wider than the hole — it covers every path in the
     * application, not only the one holding the flag.
     */
    await seed(tenantId, 1);
    await clearTenant(db);

    await expect(withOutbox((tx) => tx.execute(sql`delete from outbox`), db)).rejects.toThrow();

    expect(await allRows()).toHaveLength(1);
  });

  it('does not let an ordinary tenant delete its own rows either', async () => {
    // The revoke is at the grant, so it is not conditional on the flag. Stated
    // separately because it is the half a reader would assume still works.
    await seed(tenantId, 1);

    await expect(db.execute(sql`delete from outbox`)).rejects.toThrow();
  });
});

describe('claiming', () => {
  it('takes the oldest rows first and skips what is already published', async () => {
    await seed(tenantId, 1, 'already-sent');
    await seed(tenantId, 2, 'waiting');
    await useTenant(db, tenantId);
    await db.execute(sql`update outbox set processed_at = now() where event_type = 'already-sent'`);
    await clearTenant(db);

    const claimed = await withOutbox((tx) => claimOutboxJobs(tx, 100), db);

    expect(claimed.map((job) => job.eventType)).toEqual(['waiting', 'waiting']);
    // Ascending, which is what `order by id` on a bigserial buys: the poller
    // publishes in the order the sellers made their edits.
    expect([...claimed].sort((a, b) => a.id - b.id).map((job) => job.id)).toEqual(
      claimed.map((job) => job.id),
    );
  });

  it('leaves rows that have been given up on', async () => {
    await seed(tenantId, 2);
    await useTenant(db, tenantId);
    await db.execute(sql`update outbox set attempts = ${MAX_PUBLISH_ATTEMPTS}`);
    await clearTenant(db);

    expect(await withOutbox((tx) => claimOutboxJobs(tx, 100), db)).toHaveLength(0);
    expect(await withOutbox((tx) => countStuckJobs(tx), db)).toBe(2);
  });

  it('reports the payload the worker needs, typed the way it will be read', async () => {
    await seed(tenantId, 1);
    await clearTenant(db);

    const [claimed] = await withOutbox((tx) => claimOutboxJobs(tx, 1), db);

    expect(claimed?.tenantId).toBe(tenantId);
    expect(claimed?.eventType).toBe('embedding.requested');
    expect(claimed?.payload).toEqual({ reason: 'created' });
    /*
     * `attempts` and `id` come back as numbers. postgres-js hands some numerics
     * over as strings, and a string attempt count compares wrong against the
     * give-up threshold — `'11' < 6` is true — which would put a row back in
     * the working set for ever.
     */
    expect(typeof claimed?.attempts).toBe('number');
    expect(typeof claimed?.id).toBe('number');
  });
});

describe('two pollers at once', () => {
  it('never hand the same job to both', async () => {
    /*
     * **`SKIP LOCKED` is the entire mechanism, and this is the only place it
     * can be demonstrated.** The schedule firing while an opportunistic run is
     * still going is not exotic — it is the expected case during an import. Two
     * pollers reading the same hundred rows would publish each job twice, and
     * nothing downstream would report it: the embeddings would simply be
     * computed and paid for twice.
     */
    await seed(tenantId, 6);
    await clearTenant(db);

    let releaseFirst: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });

    let firstClaimed: () => void = () => undefined;
    const claimed = new Promise<void>((resolve) => {
      firstClaimed = resolve;
    });

    let first: readonly OutboxJob[] = [];

    const pollerA = withOutbox(async (tx) => {
      first = await claimOutboxJobs(tx, 3);
      firstClaimed();
      await held;
      return first;
    }, db);

    await claimed;

    // The second poller runs while the first still holds its locks.
    const secondClaim = await withOutbox((tx) => claimOutboxJobs(tx, 3), otherDb);

    releaseFirst();
    await pollerA;

    const firstIds = first.map((job) => job.id);
    const secondIds = secondClaim.map((job) => job.id);

    expect(firstIds).toHaveLength(3);
    expect(secondIds).toHaveLength(3);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });
});

describe('releasing', () => {
  it('marks only what was published', async () => {
    await seed(tenantId, 3);
    await clearTenant(db);

    const passed = await runOutboxPass(
      // Only the first job lands. The other two are a partial batch failure,
      // which is the ordinary case for SendMessageBatch rather than an edge.
      (jobs) => Promise.resolve(jobs.slice(0, 1).map((job) => job.id)),
      { database: db },
    );

    expect(passed).toEqual({ claimed: 3, published: 1, failed: 2 });
    expect((await allRows()).filter((row) => row.processed)).toHaveLength(1);
  });

  it('releases across tenants in one pass, each under its own context', async () => {
    /*
     * **The property that makes the whole design legal.** `WITH CHECK` is
     * tenant-only, so an UPDATE under the flag alone is refused: `runOutboxPass`
     * has to set `app.tenant_id` from each claimed row before it writes. If the
     * grouping were wrong — one tenant's context used for another's rows — the
     * update would not write the wrong rows, it would silently write *no* rows,
     * and those jobs would be re-published for ever.
     */
    await seed(tenantId, 2);
    await seed(otherTenantId, 2);
    await clearTenant(db);

    const passed = await runOutboxPass((jobs) => Promise.resolve(jobs.map((job) => job.id)), {
      database: db,
    });

    expect(passed).toEqual({ claimed: 4, published: 4, failed: 0 });
    expect((await allRows()).every((row) => row.processed)).toBe(true);
  });

  it('leaves a failed job claimable and counts the attempt', async () => {
    /*
     * The reverse ordering — mark, then send — loses a job on every crash in
     * the gap, and loses it silently: a row with `processed_at` set looks
     * exactly like one that worked. This asserts the ordering by asserting its
     * consequence.
     */
    await seed(tenantId, 2);
    await clearTenant(db);

    await runOutboxPass(() => Promise.resolve([]), { database: db });

    expect(await allRows()).toEqual([
      { tenant_id: tenantId, attempts: 1, processed: false },
      { tenant_id: tenantId, attempts: 1, processed: false },
    ]);
  });

  it('accumulates attempts until the job is set aside', async () => {
    await seed(tenantId, 1);
    await clearTenant(db);

    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
      await runOutboxPass(() => Promise.resolve([]), { database: db });
    }

    // Nothing left to claim, and the row is still there to be found.
    expect(await withOutbox((tx) => claimOutboxJobs(tx, 100), db)).toHaveLength(0);
    expect(await withOutbox((tx) => countStuckJobs(tx), db)).toBe(1);
    expect(await allRows()).toHaveLength(1);
  });

  it('does nothing at all for an empty id list', async () => {
    // Both releases are called for every tenant in a pass, and a pass that
    // published everything hands `recordPublishFailure` an empty list. A
    // statement built with no ids would have no WHERE clause worth the name.
    await seed(tenantId, 2);
    await clearTenant(db);

    await withOutbox(async (tx) => {
      await markOutboxPublished(tx, []);
      await recordPublishFailure(tx, []);
    }, db);

    expect(await allRows()).toEqual([
      { tenant_id: tenantId, attempts: 0, processed: false },
      { tenant_id: tenantId, attempts: 0, processed: false },
    ]);
  });
});
