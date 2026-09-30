import { sql } from 'drizzle-orm';

import { asDate, type SqlTimestamp } from './timestamps.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * Development mode (P4-19b): one exact local origin the widget may be served
 * to, for a fixed time.
 *
 * Statements on the caller's `withTenant`, under the tenants policy, so each
 * reaches the one winery that is set. **The expiry is the database's**: these
 * write it, and the tenants policy (0059) and the widget's resolution both
 * compare it with `now()` on every request, so a grant ends on time whether or
 * not anything here runs again.
 */

export interface DevMode {
  readonly origin: string;
  readonly expiresAt: Date;
}

/** The development mode in force, or `undefined` when there is none or it has run out. */
export const readDevMode = async (tx: DbTransaction): Promise<DevMode | undefined> => {
  const rows = await tx.execute(sql`
    SELECT dev_origin, dev_mode_expires_at FROM tenants
    WHERE dev_origin IS NOT NULL AND dev_mode_expires_at > now()
    LIMIT 1
  `);
  const row = [...rows][0] as { dev_origin: string; dev_mode_expires_at: SqlTimestamp } | undefined;

  return row === undefined
    ? undefined
    : { origin: row.dev_origin, expiresAt: asDate(row.dev_mode_expires_at) };
};

/**
 * Starts development mode for one origin, replacing any earlier one.
 *
 * The window is computed in SQL from `now()`, never passed in: a clock the
 * caller supplies is a clock the caller can move (P4-04's reasoning).
 */
export const enableDevMode = async (
  tx: DbTransaction,
  origin: string,
  hours: number,
): Promise<DevMode> => {
  const rows = await tx.execute(sql`
    UPDATE tenants
    SET dev_origin = ${origin},
        dev_mode_expires_at = now() + make_interval(hours => ${hours}),
        updated_at = now()
    RETURNING dev_origin, dev_mode_expires_at
  `);
  const row = [...rows][0] as { dev_origin: string; dev_mode_expires_at: SqlTimestamp };

  return { origin: row.dev_origin, expiresAt: asDate(row.dev_mode_expires_at) };
};

/**
 * Ends development mode now. Returns the origin it was for, whether or not it
 * had already run out, so the caller can cut off that origin's sessions too.
 */
export const endDevMode = async (tx: DbTransaction): Promise<string | undefined> => {
  const current = await tx.execute(sql`SELECT dev_origin FROM tenants FOR UPDATE`);
  const origin = ([...current][0] as { dev_origin: string | null } | undefined)?.dev_origin;

  await tx.execute(sql`
    UPDATE tenants SET dev_origin = NULL, dev_mode_expires_at = NULL, updated_at = now()
  `);

  return origin ?? undefined;
};
