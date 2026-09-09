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
 * **This file is the guard on the one policy in this repository that widens
 * rather than narrows.** `withOutbox` sets a GUC that lets a transaction read
 * every tenant's outbox rows, which is what draining one queue for the whole
 * platform requires and which nothing else here does. A unit test can only
 * check the generated SQL says what was intended; whether Postgres *enforces*
 * it — that the flag is genuinely required, and that it genuinely admits
 * nothing but a read and a release — is only answerable here.
 *
 * `SKIP LOCKED` is the other reason: two pollers taking disjoint rows is a
 * property of the lock manager, and no amount of mocking demonstrates it.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let second: DbClient | undefined;
let db: Database;
let otherDb: Database;
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
}, 180_000);

afterAll(async () => {
  await client?.close();
  await second?.close();
  await container?.stop();
}, 60_000);

const seed = async (
  tenant: string,
  count: number,
  event = 'embedding.requested',
): Promise<void> => {
  for (let index = 0; index < count; index += 1) {
    await db.execute(sql`
      insert into outbox (tenant_id, aggregate_id, event_type, payload)
      values (${tenant}::uuid, gen_random_uuid(), ${event}, ${JSON.stringify({ reason: 'created' })}::jsonb)
    `);
  }
};

beforeEach(async () => {
  tenantId = await createTenant(db, 'poller');
  otherTenantId = await createTenant(db, 'poller-other');

  // Left scoped to the first tenant, so a test that forgets to change context
  // sees one tenant's rows rather than none — the ordinary application state.
  await useTenant(db, tenantId);
});

describe('the flag is what unlocks the queue', () => {
  it('shows a poller every tenant, which is the whole point', async () => {
    await useTenant(db, tenantId);
    await seed(tenantId, 2);
    await useTenant(db, otherTenantId);
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
     * Permissive policies OR together, so the risk in amending a protected
     * table is not that the new policy is too narrow — it is that the old one
     * stops applying. This is `tenant_isolation` still doing its job with the
     * poller's policies installed alongside it.
     */
    await useTenant(db, tenantId);
    await seed(tenantId, 2);
    await useTenant(db, otherTenantId);
    await seed(otherTenantId, 4);

    const rows = await db.execute(sql`select id from outbox`);

    expect([...rows]).toHaveLength(4);
  });
});

describe('what the flag does not unlock', () => {
  it('refuses an insert', async () => {
    /*
     * **The reason the unlock is split by command rather than written as
     * `FOR ALL`.** An INSERT under the flag could write an outbox row naming
     * any tenant — a job pointing into somebody else's catalogue, created by a
     * path that never had that tenant's context. The poller never inserts, so
     * the policy does not admit it, and this is what proves the difference is
     * real rather than merely intended.
     */
    /*
     * The tenant context is dropped first so the *only* thing in play is the
     * flag. Left set, `tenant_isolation` would decide the outcome and the test
     * would pass whatever the poller's policies said.
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
    ).rejects.toThrow(/row-level security/i);
  });

  it('refuses a delete', async () => {
    // A queue that can be emptied by the thing draining it keeps no record of
    // what it failed to publish — the rows a `FOR ALL` unlock would have let go.
    await useTenant(db, tenantId);
    await seed(tenantId, 1);
    await clearTenant(db);

    // No error: with no DELETE policy the rows are simply not visible to the
    // statement, so it removes nothing and says so by affecting no rows.
    await withOutbox((tx) => tx.execute(sql`delete from outbox`), db);

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`select id from outbox`);

    expect([...rows]).toHaveLength(1);
  });
});

describe('claiming', () => {
  it('takes the oldest rows first and skips what is already published', async () => {
    await seed(tenantId, 1, 'already-sent');
    await seed(tenantId, 2, 'waiting');
    await db.execute(sql`update outbox set processed_at = now() where event_type = 'already-sent'`);

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
    await db.execute(sql`update outbox set attempts = ${MAX_PUBLISH_ATTEMPTS}`);

    const claimed = await withOutbox((tx) => claimOutboxJobs(tx, 100), db);

    expect(claimed).toHaveLength(0);
    expect(await withOutbox((tx) => countStuckJobs(tx), db)).toBe(2);
  });

  it('reports the payload the worker needs and nothing more', async () => {
    await seed(tenantId, 1);

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
    const second = await withOutbox((tx) => claimOutboxJobs(tx, 3), otherDb);

    releaseFirst();
    await pollerA;

    const firstIds = first.map((job) => job.id);
    const secondIds = second.map((job) => job.id);

    expect(firstIds).toHaveLength(3);
    expect(secondIds).toHaveLength(3);
    expect(firstIds.filter((id) => secondIds.includes(id))).toEqual([]);
  });
});

describe('releasing', () => {
  it('marks only what was published', async () => {
    await seed(tenantId, 3);

    const passed = await runOutboxPass(
      // Only the first job lands. The other two are a partial batch failure,
      // which is the ordinary case for SendMessageBatch rather than an edge.
      (jobs) => Promise.resolve(jobs.slice(0, 1).map((job) => job.id)),
      { database: db },
    );

    expect(passed).toEqual({ claimed: 3, published: 1, failed: 2 });

    await useTenant(db, tenantId);
    const rows = await db.execute(
      sql`select count(*)::int as n from outbox where processed_at is not null`,
    );

    expect(Number([...rows][0]?.n)).toBe(1);
  });

  it('leaves a failed job claimable and counts the attempt', async () => {
    /*
     * The reverse ordering — mark, then send — loses a job on every crash in
     * the gap, and loses it silently: a row with `processed_at` set looks
     * exactly like one that worked. This asserts the ordering by asserting its
     * consequence.
     */
    await seed(tenantId, 2);

    await runOutboxPass(() => Promise.resolve([]), { database: db });

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`select attempts, processed_at from outbox order by id`);

    for (const row of [...rows]) {
      expect(row.processed_at).toBeNull();
      expect(Number(row.attempts)).toBe(1);
    }
  });

  it('accumulates attempts until the job is set aside', async () => {
    await seed(tenantId, 1);

    for (let attempt = 0; attempt < MAX_PUBLISH_ATTEMPTS; attempt += 1) {
      await runOutboxPass(() => Promise.resolve([]), { database: db });
    }

    // Nothing left to claim, and the row is still there to be found.
    const claimedAfter = await withOutbox((tx) => claimOutboxJobs(tx, 100), db);

    expect(claimedAfter).toHaveLength(0);
    expect(await withOutbox((tx) => countStuckJobs(tx), db)).toBe(1);
  });

  it('does nothing at all for an empty id list', async () => {
    // Both releases are called on every pass, and a pass that published
    // everything hands `recordPublishFailure` an empty list. A statement built
    // with no ids would have no WHERE clause worth the name.
    await seed(tenantId, 2);

    await withOutbox(async (tx) => {
      await markOutboxPublished(tx, []);
      await recordPublishFailure(tx, []);
    }, db);

    await useTenant(db, tenantId);
    const rows = await db.execute(sql`select attempts, processed_at from outbox`);

    for (const row of [...rows]) {
      expect(row.processed_at).toBeNull();
      expect(Number(row.attempts)).toBe(0);
    }
  });
});
