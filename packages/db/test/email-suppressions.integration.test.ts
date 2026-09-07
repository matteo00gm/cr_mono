import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { isSuppressed, suppressAddress, unsuppressAddress } from '../src/email-suppressions.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `email_suppressions` against real Postgres (P0-64).
 *
 * The unit tests in `packages/core` assert that a suppressed address is not
 * mailed. What can only be asserted here is that the *storage* behaves: that a
 * redelivered bounce does not move the timestamp, and that the table is
 * readable with no tenant context — which is the property that makes a bounce
 * caused by one winery protect the sending domain for all of them.
 */

let container: StartedPostgreSqlContainer | undefined;
let client: DbClient | undefined;
let db: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  client = createDbClient(started.roleUrl('app_rw'), { max: 1 });
  db = client.db;
}, 180_000);

afterAll(async () => {
  await client?.close();
  await container?.stop();
}, 60_000);

const suppressedAt = async (address: string): Promise<Date | undefined> => {
  const rows = await db.execute(
    sql`select suppressed_at from email_suppressions where address = ${address}`,
  );

  const row = [...rows][0] as { suppressed_at?: Date } | undefined;
  return row?.suppressed_at;
};

describe('email_suppressions', () => {
  it('records a bounce and reads it back with no tenant context', async () => {
    /*
     * Deliberately outside `withTenant`. The table carries no `tenant_id` and
     * no RLS policy, and this is the assertion that says so: if someone adds a
     * policy later, this read returns nothing and the send path silently stops
     * suppressing anything.
     */
    await suppressAddress(db, {
      address: 'dead@example.invalid',
      reason: 'hard_bounce',
      detail: '550 5.1.1 user unknown',
    });

    expect(await isSuppressed(db, 'dead@example.invalid')).toBe(true);
    expect(await isSuppressed(db, 'alive@example.invalid')).toBe(false);
  });

  it('does not move the timestamp when a webhook is redelivered', async () => {
    await suppressAddress(db, { address: 'repeat@example.invalid', reason: 'hard_bounce' });
    const first = await suppressedAt('repeat@example.invalid');

    // Providers redeliver. The first record of a bounce is the accurate one —
    // overwriting it would make an old problem look new to the bounce-rate
    // alarm, which is the signal the whole table exists to feed.
    await suppressAddress(db, { address: 'repeat@example.invalid', reason: 'complaint' });

    expect(await suppressedAt('repeat@example.invalid')).toEqual(first);

    const rows = await db.execute(
      sql`select reason from email_suppressions where address = 'repeat@example.invalid'`,
    );
    expect([...rows]).toHaveLength(1);
    expect(([...rows][0] as { reason?: string }).reason).toBe('hard_bounce');
  });

  it('stores a null detail rather than the string "null"', async () => {
    // `detail ?? null` is easy to write as `String(detail)` by accident, and the
    // result is a column full of the word "null" for the operator reading it.
    await suppressAddress(db, { address: 'nodetail@example.invalid', reason: 'complaint' });

    const rows = await db.execute(
      sql`select detail from email_suppressions where address = 'nodetail@example.invalid'`,
    );
    expect(([...rows][0] as { detail?: unknown }).detail).toBeNull();
  });

  it('can be lifted', async () => {
    /*
     * A mailbox that was full last month is a customer who cannot reset their
     * password this month, so the table must be writable and deletable by the
     * runtime role — unlike the append-only ledgers (P0-33a), where the
     * opposite is the invariant. This asserts the grant as much as the query.
     */
    await suppressAddress(db, { address: 'recovered@example.invalid', reason: 'hard_bounce' });
    expect(await isSuppressed(db, 'recovered@example.invalid')).toBe(true);

    await unsuppressAddress(db, 'recovered@example.invalid');
    expect(await isSuppressed(db, 'recovered@example.invalid')).toBe(false);
  });
});
