import process from 'node:process';
import { drizzle, type PostgresJsDatabase } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

/**
 * Connection factory (P0-18).
 *
 * Internal to this package. `withTenant` is the only sanctioned way to reach
 * the database, so nothing here is re-exported from `index.ts` — see the note
 * there for why that has to hold at the export surface.
 */

export type Database = PostgresJsDatabase;

export interface DbClient {
  readonly db: Database;
  /** Releases the pool. Required by tests; also the graceful-shutdown path. */
  readonly close: () => Promise<void>;
}

export interface DbClientOptions {
  /**
   * Pool size. Kept small because it multiplies against Lambda concurrency:
   * at the P1-48 reserved concurrency of 10, `max: 2` is already 20 connections
   * against a `t4g.micro` (§5.1). Configurable only because the RLS integration
   * suite needs `max: 1` to prove context does not survive on a reused
   * connection.
   */
  readonly max?: number;
}

export const createDbClient = (url: string, options: DbClientOptions = {}): DbClient => {
  const sql = postgres(url, {
    max: options.max ?? 2,
    // Not knobs — deployment invariants, so they are not exposed as options.
    // `prepare: false` keeps transactions correct behind a transaction-mode
    // pooler; the timeouts fail fast and release sockets under RDS's own idle
    // limit rather than waiting on a dead connection.
    prepare: false,
    idle_timeout: 20,
    connect_timeout: 5,
  });

  return {
    db: drizzle({ client: sql }),
    close: () => sql.end(),
  };
};

let cached: DbClient | undefined;

/**
 * Memoised client for the Lambda container's lifetime.
 *
 * Deliberately takes no arguments. An earlier version accepted an optional URL
 * and ignored it once cached, so a second call with a different URL silently
 * returned the first connection.
 */
export const getDb = (): Database => {
  cached ??= createDbClient(requireDatabaseUrl());
  return cached.db;
};

export const closeDb = async (): Promise<void> => {
  await cached?.close();
  cached = undefined;
};

const requireDatabaseUrl = (): string => {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error(
      'DATABASE_URL is not set. It is mirrored to SSM as /sommelier/<stage>/database/url (P0-15).',
    );
  }
  return url;
};
