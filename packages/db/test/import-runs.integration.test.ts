import { randomUUID } from 'node:crypto';

import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import {
  claimImportRun,
  completeImportRun,
  IMPORT_CLAIM_EXPIRES_AFTER_SECONDS,
  type ImportRunRequest,
} from '../src/import-runs.js';
import type { DbTransaction } from '../src/with-tenant.js';
import { startPostgres, type TestPostgres } from './support/postgres.js';
import { createTenant } from './support/tenant.js';

/**
 * Import attempts against a real database (P1-26).
 *
 * The row's tests — the same key twice is answered from the first attempt, the
 * same key with a different body is refused — plus what makes the guard hold
 * under real conditions: two claims racing, a claim abandoned by a killed
 * invocation, and one winery's key never touching another's.
 *
 * One connection for the suite, because `createTenant` scopes the *session*
 * and a pool would hand the next statement a connection it never scoped. The
 * race opens its own pool of two, which is the point of it.
 */

let started: TestPostgres | undefined;
let client: DbClient | undefined;
let db: Database;
let tenantId: string;

beforeAll(async () => {
  started = await startPostgres();
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await started?.container.stop();
}, 60_000);

beforeEach(async () => {
  tenantId = await createTenant(db, 'runs');
});

const inTenant = <T>(
  run: (tx: DbTransaction) => Promise<T>,
  tenant = tenantId,
  on: Database = db,
): Promise<T> =>
  on.transaction(async (tx) => {
    await tx.execute(sql`select set_config('app.tenant_id', ${tenant}, true)`);
    return run(tx);
  });

/** Built at runtime: a key-shaped literal is what the secret scan stops (P0-56). */
const KEY = randomUUID();

const request = (over: Partial<ImportRunRequest> = {}): ImportRunRequest => ({
  tenantId,
  idempotencyKey: KEY,
  requestHash: 'hash-of-the-rows',
  ...over,
});

const claim = (over: Partial<ImportRunRequest> = {}) =>
  inTenant((tx) => claimImportRun(tx, request(over)), over.tenantId ?? tenantId);

const complete = (runId: string, result: unknown) =>
  inTenant((tx) => completeImportRun(tx, { runId, result }));

/** Ages every claim this tenant holds, standing in for the wait. */
const ageClaims = (interval: string) =>
  inTenant((tx) =>
    tx.execute(sql`update import_runs set claimed_at = now() - ${interval}::interval`),
  );

const RESULT = {
  outcomes: [{ index: 0, outcome: 'created', productId: 'p-1' }],
  counts: { created: 1, updated: 0, unchanged: 0, duplicateSku: 0, archived: 0 },
  stoppedAt: null,
};

describe('claimImportRun', () => {
  it('claims a new key, and answers a repeat with the stored result once it completes', async () => {
    const first = await claim();
    if (first.outcome !== 'claimed') throw new Error(`expected a claim, got ${first.outcome}`);

    await complete(first.runId, RESULT);

    expect(await claim()).toEqual({ outcome: 'replay', result: RESULT });
  });

  it('says a repeat that arrives while the first attempt runs is still in progress', async () => {
    await claim();

    expect(await claim()).toEqual({ outcome: 'in-progress' });
  });

  it('refuses the same key with a different body, before and after the first completes', async () => {
    const first = await claim();
    if (first.outcome !== 'claimed') throw new Error('expected a claim');

    expect(await claim({ requestHash: 'another-body' })).toEqual({ outcome: 'different-body' });

    await complete(first.runId, RESULT);

    expect(await claim({ requestHash: 'another-body' })).toEqual({ outcome: 'different-body' });
  });

  it('lets exactly one of two overlapping claims win, and tells the other it is in progress', async () => {
    if (started === undefined) throw new Error('database not started');
    const race = createDbClient(started.roleUrl('app_rw'), { max: 2 });

    try {
      let claimed!: () => void;
      let commit!: () => void;
      const firstHasClaimed = new Promise<void>((resolve) => (claimed = resolve));
      const firstMayCommit = new Promise<void>((resolve) => (commit = resolve));

      const first = inTenant(
        async (tx) => {
          const outcome = await claimImportRun(tx, request());
          claimed();
          await firstMayCommit;
          return outcome;
        },
        tenantId,
        race.db,
      );

      await firstHasClaimed;
      const second = inTenant((tx) => claimImportRun(tx, request()), tenantId, race.db);

      // The second insert must be waiting on the first's uncommitted key before
      // the first commits, or this is two claims in a row rather than a race.
      for (let waited = 0; ; waited += 50) {
        const rows = await db.execute(
          sql`select count(*)::int as n from pg_stat_activity where wait_event_type = 'Lock'`,
        );
        if (([...rows][0] as { n: number }).n > 0) break;
        if (waited > 5_000) throw new Error('the second claim never waited on the first');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      commit();

      expect((await first).outcome).toBe('claimed');
      expect(await second).toEqual({ outcome: 'in-progress' });
    } finally {
      await race.close();
    }
  });

  it('takes over a claim abandoned past its expiry, for the same body only', async () => {
    const abandoned = await claim();
    if (abandoned.outcome !== 'claimed') throw new Error('expected a claim');

    await ageClaims(`${String(IMPORT_CLAIM_EXPIRES_AFTER_SECONDS + 1)} seconds`);

    expect(await claim({ requestHash: 'another-body' })).toEqual({ outcome: 'different-body' });
    expect(await claim()).toEqual({ outcome: 'claimed', runId: abandoned.runId });
  });

  it('does not take over a claim that is merely slow', async () => {
    await claim();
    await ageClaims(`${String(IMPORT_CLAIM_EXPIRES_AFTER_SECONDS - 1)} seconds`);

    expect(await claim()).toEqual({ outcome: 'in-progress' });
  });

  it('never takes over a completed run, however old', async () => {
    const first = await claim();
    if (first.outcome !== 'claimed') throw new Error('expected a claim');
    await complete(first.runId, RESULT);

    await ageClaims('2 days');

    expect(await claim()).toEqual({ outcome: 'replay', result: RESULT });
  });

  it('lets two wineries use the same key without either seeing the other', async () => {
    const ours = tenantId;
    const theirs = await createTenant(db, 'runs-other');

    expect((await claim({ tenantId: ours })).outcome).toBe('claimed');
    expect((await claim({ tenantId: theirs })).outcome).toBe('claimed');

    const visible = await inTenant(
      (tx) => tx.execute(sql`select count(*)::int as n from import_runs`),
      theirs,
    );
    expect(([...visible][0] as { n: number }).n).toBe(1);
  });
});
