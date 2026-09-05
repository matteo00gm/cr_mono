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
