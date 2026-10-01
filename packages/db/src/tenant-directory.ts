import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';

/**
 * Every tenant, by id — the ninth RLS scope (P5-13, ADR 0030).
 *
 * **It widens, like `withOutbox` and `withLapsedRevocations`.** The nightly
 * rollup writes a row for every tenant for every day, including the days with
 * nothing in them (a gap breaks a chart), so it must know every tenant — and
 * learning that is itself the read across tenants.
 *
 * **What bounds it is that this is not a scope a caller can hold.** There is
 * no `withTenantDirectory(fn)`: the flag is set here, inside a `READ ONLY`
 * transaction, for one statement that selects the id and the creation time,
 * and the transaction ends before anything is returned. A caller gets a list
 * of ids, and reaches each tenant's rows the ordinary way — `withTenant`.
 *
 * Transaction-local, like every other context, so a pooled connection never
 * carries it into the next request.
 */
export const TENANT_DIRECTORY_GUC = 'app.tenant_directory';

export interface TenantDirectoryEntry {
  readonly id: string;
  /** So a day is rolled up only for a tenant that existed by its end. */
  readonly createdAt: Date;
}

export const listTenantDirectory = async (
  db: Database = getDb(),
): Promise<readonly TenantDirectoryEntry[]> =>
  db.transaction(
    async (tx) => {
      await tx.execute(sql`SELECT set_config(${TENANT_DIRECTORY_GUC}, 'on', true)`);

      const rows = await tx.execute(sql`
        SELECT id, created_at FROM tenants ORDER BY created_at, id
      `);

      return [...rows].map((row) => ({
        id: String(row.id),
        createdAt: new Date(row.created_at as string | Date),
      }));
    },
    { accessMode: 'read only' },
  );
