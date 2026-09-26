import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import {
  authAccounts,
  authSessions,
  authTwoFactor,
  authUsers,
  authVerifications,
} from './schema/auth.js';

/**
 * The un-scoped connection for Better Auth, and nothing else (P0-45).
 *
 * **This is the second sanctioned path to the database, and it is deliberately
 * uncomfortable to reach.** `index.ts` exports `withTenant` and refuses to
 * export a connection precisely so that no application module can issue a query
 * without tenant context. The header there anticipates this file by name.
 *
 * The exception is not a compromise, it is a consequence of what authentication
 * *is*: you must identify the user before you can resolve which tenants they
 * belong to, so a login query has no tenant to be scoped by. `withTenant` would
 * have nothing to put in `app.tenant_id`, and the `auth_*` tables carry no
 * policy for it to satisfy (P0-23a).
 *
 * Three things keep it from becoming a general accessor:
 *
 * 1. **It is not on the package's main entry.** It is reachable only as
 *    `@catalogorosso/db/auth`, a separate export subpath — the same treatment
 *    as `/test-support`.
 * 2. **That subpath is named in the P0-09 `no-raw-db-outside-with-tenant`
 *    rule**, so importing it is a boundary violation by default, with exactly
 *    one file excepted: `packages/core/src/auth.ts`. A narrowly-named escape is
 *    only narrow if using it is checked.
 * 3. **It hands back the auth tables and nothing else.** The schema below is
 *    the five `auth_*` tables; a caller that wanted `products` would have to
 *    import it from somewhere this file does not reach.
 *
 * The consequence, stated plainly rather than left implicit: a query issued
 * through this connection is subject to RLS like any other `app_rw` query, and
 * the `auth_*` tables have no policies — so it can read every row in
 * `auth_users`. That is inherent to authentication, and it is why P0-46 tests
 * the auth paths directly instead of relying on RLS to bound them.
 */

/**
 * The connection Better Auth's adapter runs on.
 *
 * The same memoised client every other caller gets, on purpose: a second pool
 * for auth would double connection consumption against a `t4g.micro`, and
 * connection count is the constraint that caps Lambda concurrency (P1-48).
 * What is different here is the absence of `withTenant`, not the connection.
 */
export const getAuthDb = (): Database => getDb();

/**
 * The auth tables, keyed by the model names configured in `packages/core`.
 *
 * The drizzle adapter resolves `schema[model]` using the *configured*
 * `modelName`, not Better Auth's default singular name — so these keys are
 * `auth_users` rather than `user`, and they must match the `modelName` values
 * exactly or the adapter throws at the first query rather than at startup.
 */
export const authSchema = {
  auth_users: authUsers,
  auth_sessions: authSessions,
  auth_accounts: authAccounts,
  auth_verifications: authVerifications,
  auth_two_factor: authTwoFactor,
} as const;

/** The numbers the store enforces, set by the caller (P4-11). */
export interface MfaPolicy {
  /** How long a spent TOTP code stays spent. */
  readonly claimSeconds: number;
  /** Consecutive failures that lock an account. */
  readonly maxFailures: number;
  readonly lockSeconds: number;
  /** How recent a second factor must be for a sensitive action. */
  readonly freshSeconds: number;
}

/** What a sensitive action needs to know about the session asking. */
export interface SessionStepUp {
  readonly userId: string;
  readonly twoFactorEnabled: boolean;
  readonly fresh: boolean;
}

export interface AuthMfaStore {
  readonly claimTotpCode: (userId: string, codeHash: string) => Promise<boolean>;
  readonly isLocked: (userId: string) => Promise<boolean>;
  readonly recordFailure: (userId: string) => Promise<void>;
  readonly clearFailures: (userId: string) => Promise<void>;
  readonly markVerified: (sessionToken: string) => Promise<void>;
  readonly stepUpState: (sessionToken: string) => Promise<SessionStepUp | undefined>;
}

const rowsOf = <T>(result: Iterable<unknown>): T[] => [...result] as T[];

/**
 * The MFA store against the auth tables (P4-11), on the auth adapter's own
 * connection.
 *
 * Here rather than beside the hooks in `packages/core`, because this file is the
 * named exception for an un-scoped connection (P0-45) and SQL belongs in this
 * package. The numbers are the caller's: how long a claim lasts and how many
 * failures lock an account are policy, and policy lives in core.
 *
 * **Every comparison with the clock is the database's**, and every answer is a
 * boolean, so no timestamp crosses a raw `execute` as the string it arrives as.
 */
export const createMfaStore = (
  { claimSeconds, maxFailures, lockSeconds, freshSeconds }: MfaPolicy,
  db: Database = getAuthDb(),
): AuthMfaStore => ({
  claimTotpCode: async (userId, codeHash) => {
    /*
     * One statement, so the claim is atomic: an insert, or — for a claim whose
     * window has closed — a refresh of it. A live claim is left alone and
     * returns no row, which is the refusal.
     */
    const claimed = rowsOf(
      await db.execute(sql`
        INSERT INTO auth_totp_claims (user_id, code_hash) VALUES (${userId}, ${codeHash})
        ON CONFLICT (user_id, code_hash) DO UPDATE SET claimed_at = now()
        WHERE auth_totp_claims.claimed_at <= now() - make_interval(secs => ${claimSeconds}::int)
        RETURNING 1 AS claimed
      `),
    );

    /* This user's spent codes whose windows have closed. Nothing else reads them. */
    await db.execute(sql`
      DELETE FROM auth_totp_claims
      WHERE user_id = ${userId}
        AND claimed_at <= now() - make_interval(secs => ${claimSeconds}::int)
    `);

    return claimed.length === 1;
  },

  isLocked: async (userId) => {
    const [row] = rowsOf<{ locked: boolean }>(
      await db.execute(sql`
        SELECT coalesce(bool_or(locked_until > now()), false) AS locked
        FROM auth_two_factor WHERE user_id = ${userId}
      `),
    );

    return row?.locked === true;
  },

  recordFailure: async (userId) => {
    /*
     * The plugin's own lockout arithmetic, on the plugin's own columns. A lock
     * that has run out starts the count again rather than re-locking on the
     * next miss, which is what the plugin does on its sign-in path too.
     */
    await db.execute(sql`
      UPDATE auth_two_factor SET
        failed_verification_count = CASE
          WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
          ELSE failed_verification_count + 1
        END,
        locked_until = CASE
          WHEN (CASE
                  WHEN locked_until IS NOT NULL AND locked_until <= now() THEN 1
                  ELSE failed_verification_count + 1
                END) >= ${maxFailures}
            THEN now() + make_interval(secs => ${lockSeconds}::int)
          WHEN locked_until IS NOT NULL AND locked_until <= now() THEN NULL
          ELSE locked_until
        END
      WHERE user_id = ${userId}
    `);
  },

  clearFailures: async (userId) => {
    await db.execute(sql`
      UPDATE auth_two_factor SET failed_verification_count = 0, locked_until = NULL
      WHERE user_id = ${userId}
    `);
  },

  markVerified: async (sessionToken) => {
    await db.execute(sql`
      UPDATE auth_sessions SET last_verified_at = now() WHERE token = ${sessionToken}
    `);
  },

  stepUpState: async (sessionToken) => {
    const [row] = rowsOf<{ user_id: string; two_factor_enabled: boolean; fresh: boolean }>(
      await db.execute(sql`
        SELECT s.user_id, u.two_factor_enabled,
               coalesce(
                 s.last_verified_at > now() - make_interval(secs => ${freshSeconds}::int)
                   AND s.last_verified_at <= now(),
                 false
               ) AS fresh
        FROM auth_sessions s JOIN auth_users u ON u.id = s.user_id
        WHERE s.token = ${sessionToken} AND s.expires_at > now()
      `),
    );

    return row === undefined
      ? undefined
      : { userId: row.user_id, twoFactorEnabled: row.two_factor_enabled, fresh: row.fresh };
  },
});
