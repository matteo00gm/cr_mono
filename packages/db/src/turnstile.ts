import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * The Turnstile flag, and the signals that suggest turning it on (P4-14).
 *
 * **Statements only, on the caller's transaction** — `domains-write.ts`'s
 * terms. Every one reads or writes under the tenant policy, so a caller
 * outside `withTenant` finds nothing and changes nothing rather than the wrong
 * winery's row.
 */

/** Refusals in the last hour that make the challenge worth suggesting. */
export interface TurnstileSignals {
  /** A key presented from an origin it does not belong to: widget theft (§3.4). */
  readonly unauthorizedOrigins: number;
  /** Requests refused for rate, from anywhere. */
  readonly rateLimited: number;
}

export interface TurnstileState {
  readonly enabled: boolean;
  readonly signals: TurnstileSignals;
}

/**
 * The flag and the last hour's signals, in one round trip.
 *
 * Counted from `security_events`, which P2-16 already writes for every one of
 * these refusals — so the suggestion costs a read the owner asks for, and no
 * job, no rollup and no scope that reads across wineries.
 */
export const readTurnstileState = async (tx: DbTransaction): Promise<TurnstileState> => {
  const rows = await tx.execute(sql`
    SELECT
      (SELECT turnstile_enabled FROM tenants LIMIT 1) AS enabled,
      count(*) FILTER (WHERE type = 'UNAUTHORIZED_ORIGIN')::int AS unauthorized_origins,
      count(*) FILTER (WHERE type = 'RATE_LIMITED')::int AS rate_limited
    FROM security_events
    WHERE created_at > now() - interval '1 hour'
  `);

  const row = [...rows][0] as
    { enabled: boolean | null; unauthorized_origins: number; rate_limited: number } | undefined;

  return {
    enabled: row?.enabled === true,
    signals: {
      unauthorizedOrigins: row?.unauthorized_origins ?? 0,
      rateLimited: row?.rate_limited ?? 0,
    },
  };
};

/** `false` when there was no tenant row to change — outside a scope, say. */
export const setTurnstileEnabled = async (
  tx: DbTransaction,
  enabled: boolean,
): Promise<boolean> => {
  const rows = await tx.execute(sql`
    UPDATE tenants SET turnstile_enabled = ${enabled}
    RETURNING id
  `);

  return [...rows].length === 1;
};
