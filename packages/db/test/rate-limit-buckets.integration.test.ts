import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * `rate_limit_buckets` against real Postgres (P0-34).
 *
 * Limiter behaviour is P2-03's job. What is asserted here is the storage
 * tuning, because a later `ALTER TABLE` could drop it silently and nothing
 * about a passing limiter test would notice the table had started bloating.
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

/**
 * Storage parameters as a map of name to number.
 *
 * Parsed rather than string-matched: Postgres normalises what it stores, so
 * `scale_factor = 0.0` comes back as `0.0` and an exact-string assertion fails
 * on formatting while the setting is correct.
 */
const reloptions = async (): Promise<Map<string, number>> => {
  const rows = await db.execute(sql`
    select unnest(reloptions) as option from pg_class where relname = 'rate_limit_buckets'
  `);

  return new Map(
    [...rows].map((row) => {
      const [name, value] = String((row as { option: unknown }).option).split('=');

      return [String(name), Number(value)] as const;
    }),
  );
};

describe('rate_limit_buckets', () => {
  it('keeps the churn tuning the migration set', async () => {
    const options = await reloptions();

    expect(options.get('fillfactor')).toBe(70);
    // Absolute threshold with a zero scale factor: vacuuming has to depend on
    // churn, not on a percentage of a table kept deliberately small.
    expect(options.get('autovacuum_vacuum_threshold')).toBe(200);
    expect(options.get('autovacuum_vacuum_scale_factor')).toBe(0);
    expect(options.get('autovacuum_vacuum_cost_delay')).toBe(0);
  });

  it('increments a window in a single statement', async () => {
    // The shape P2-02 uses. Two round trips would leave a gap between reading
    // a count and writing it, which is the classic way a limiter is bypassed.
    const bump = () =>
      db.execute(sql`
        insert into rate_limit_buckets (bucket_key, window_start, count)
        values ('tenant:abc:min', '2026-09-03T10:00:00Z', 1)
        on conflict (bucket_key, window_start)
        do update set count = rate_limit_buckets.count + 1
        returning count
      `);

    await bump();
    const second = await bump();

    expect(Number([...second][0]?.count)).toBe(2);
  });

  it('separates windows for the same subject', async () => {
    await db.execute(sql`
      insert into rate_limit_buckets (bucket_key, window_start, count)
      values ('session:xyz', '2026-09-03T10:00:00Z', 5), ('session:xyz', '2026-09-03T10:01:00Z', 1)
    `);

    const rows = await db.execute(sql`
      select count(*)::int as windows from rate_limit_buckets where bucket_key = 'session:xyz'
    `);

    expect(Number([...rows][0]?.windows)).toBe(2);
  });

  it('lets the prune job delete closed windows', async () => {
    // Unlike the ledgers, app_rw must keep DELETE here: P2-14 sweeps this table
    // and it is the one place where deletion is the point.
    await db.execute(sql`
      insert into rate_limit_buckets (bucket_key, window_start) values ('ip:old', '2026-01-01T00:00:00Z')
    `);
    await db.execute(
      sql`delete from rate_limit_buckets where window_start < '2026-02-01T00:00:00Z'`,
    );

    const rows = await db.execute(
      sql`select 1 from rate_limit_buckets where bucket_key = 'ip:old'`,
    );

    expect([...rows]).toHaveLength(0);
  });
});
