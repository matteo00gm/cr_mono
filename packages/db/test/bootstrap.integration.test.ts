import { sql } from 'drizzle-orm';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { createDbClient, type Database, type DbClient } from '../src/client.js';
import { applyBootstrap, startPostgres } from './support/postgres.js';
import type { StartedPostgreSqlContainer } from '@testcontainers/postgresql';

/**
 * Bootstrap: extensions (P0-20).
 *
 * The assertions are about the database the rest of P0 is built on, so they are
 * deliberately literal: the extension is installed, and the type P0-27 commits
 * to actually exists on this server.
 */

let container: StartedPostgreSqlContainer | undefined;
let admin: DbClient | undefined;
let adminUrl: string;
let db: Database;

beforeAll(async () => {
  const started = await startPostgres();
  container = started.container;
  adminUrl = started.adminUrl;

  admin = createDbClient(adminUrl, { max: 1 });
  db = admin.db;
}, 180_000);

afterAll(async () => {
  await admin?.close();
  await container?.stop();
}, 60_000);

describe('bootstrap/0000_extensions', () => {
  it.each(['vector', 'pg_trgm', 'unaccent', 'citext'])('installs %s', async (extension) => {
    const rows = await db.execute(sql`select 1 from pg_extension where extname = ${extension}`);

    expect([...rows]).toHaveLength(1);
  });

  it('provides halfvec, the type P0-27 depends on', async () => {
    // to_regtype returns null rather than raising for an unknown type, so this
    // reads as "is it there" instead of needing the query to be wrapped.
    const rows = await db.execute(sql`select to_regtype('halfvec') is not null as present`);

    expect([...rows][0]?.present).toBe(true);
  });

  it('ships a pgvector new enough for halfvec', async () => {
    const rows = await db.execute(
      sql`select extversion from pg_extension where extname = 'vector'`,
    );
    const version = String([...rows][0]?.extversion);

    // Compared numerically, per component. The migration itself asserts the
    // capability rather than the number; this asserts the pin in
    // support/postgres.ts has not been moved below the floor it documents.
    const [major = 0, minor = 0] = version.split('.').map(Number);
    expect(major * 1000 + minor).toBeGreaterThanOrEqual(7);
  });

  it('is idempotent — re-applying bootstrap changes nothing', async () => {
    // The property that lets bootstrap run on every deploy rather than being a
    // one-shot someone has to remember not to repeat.
    const before = await db.execute(sql`select extname, extversion from pg_extension order by 1`);

    await applyBootstrap(adminUrl);

    const after = await db.execute(sql`select extname, extversion from pg_extension order by 1`);
    expect([...after]).toEqual([...before]);
  });
});
