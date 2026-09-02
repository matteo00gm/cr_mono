import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `processed_webhooks` against real Postgres (P0-33).
 */

const pgErrorCode = (error: unknown): string | undefined =>
  (error as { cause?: { code?: string } } | undefined)?.cause?.code;

/** unique_violation — what the handler reads as "already processed". */
const UNIQUE_VIOLATION = '23505';

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

const record = (provider: string, eventId: string) =>
  db.execute(
    sql`insert into processed_webhooks (provider, event_id) values (${provider}, ${eventId})`,
  );

describe('processed_webhooks', () => {
  it('records an event the first time it is seen', async () => {
    await record('stripe', 'evt_first');

    const rows = await db.execute(
      sql`select processed_at from processed_webhooks where provider = 'stripe' and event_id = 'evt_first'`,
    );

    expect([...rows]).toHaveLength(1);
  });

  it('rejects the same event twice, which is how a retry is absorbed', async () => {
    // Stripe retries on its own schedule after a timeout it decided on. This
    // rejection is the mechanism: the handler reads 23505 as "already done"
    // rather than as a failure.
    await record('stripe', 'evt_retried');
    const error = await record('stripe', 'evt_retried').catch((caught: unknown) => caught);

    expect(pgErrorCode(error)).toBe(UNIQUE_VIOLATION);
  });

  it('keeps the same event id distinct across providers', async () => {
    // Event ids are only unique within a provider, which is why provider leads
    // the key. Shopify arrives at P6-07.
    await record('stripe', 'evt_shared');
    await record('shopify', 'evt_shared');

    const rows = await db.execute(
      sql`select count(*)::int as seen from processed_webhooks where event_id = 'evt_shared'`,
    );

    expect(Number([...rows][0]?.seen)).toBe(2);
  });

  it('lets the handler claim an event and detect the loser of a race', async () => {
    // Two deliveries of the same event can arrive concurrently. The shape the
    // handler actually uses: insert, and if nothing was inserted, someone else
    // is already handling it.
    await record('stripe', 'evt_raced');

    const rows = await db.execute(sql`
      insert into processed_webhooks (provider, event_id) values ('stripe', 'evt_raced')
      on conflict (provider, event_id) do nothing
      returning event_id
    `);

    expect([...rows]).toHaveLength(0);
  });
});
