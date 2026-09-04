import { randomUUID } from 'node:crypto';
import { sql } from 'drizzle-orm';

import type { Database } from '../../src/client.js';

/**
 * Tenant context for the integration suites, after P0-37 (RLS).
 *
 * Before RLS these suites inserted a tenant and then wrote rows referencing it,
 * with nothing scoping the connection. That works right up until the policies
 * exist, at which point every one of those writes is rejected by `WITH CHECK`
 * and every read returns nothing — correctly. The suites were relying on the
 * absence of the guarantee they exist to protect.
 *
 * These helpers set the same GUC `withTenant` sets. They deliberately do *not*
 * wrap it: `withTenant` opens a transaction and uses `SET LOCAL`, which is
 * right for the application and wrong here, where a suite needs the context to
 * outlive the statement so `beforeEach` can seed and the test can then read.
 */

/** Scopes the session to a tenant. Session-level, so it survives statements. */
export const useTenant = async (db: Database, tenantId: string): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', ${tenantId}, false)`);
};

/** Scopes the session to a user, for the `memberships` login-path branch. */
export const useUser = async (db: Database, userId: string): Promise<void> => {
  await db.execute(sql`select set_config('app.user_id', ${userId}, false)`);
};

/** Drops all context, leaving the connection able to see nothing. */
export const clearTenant = async (db: Database): Promise<void> => {
  await db.execute(sql`select set_config('app.tenant_id', '', false)`);
  await db.execute(sql`select set_config('app.user_id', '', false)`);
};

/**
 * Creates a tenant and leaves the session scoped to it.
 *
 * The id is generated here and the context set *before* the insert, because
 * `tenants` carries `WITH CHECK (id = app.tenant_id)` — the row has to satisfy
 * the policy it is creating the context for. This is the same shape signup
 * uses in production, which is the point: the tests exercise the real path
 * rather than a test-only escape.
 */
export const createTenant = async (db: Database, label: string): Promise<string> => {
  const id = randomUUID();

  await useTenant(db, id);
  await db.execute(sql`
    insert into tenants (id, name, slug)
    values (${id}::uuid, ${label}, ${`${label}-${id}`})
  `);

  return id;
};

/**
 * Creates a Better Auth user, for suites that need a membership (P0-23a).
 *
 * `memberships.user_id` now carries a foreign key to `auth_users`, so a suite
 * can no longer invent a user id. Deliberately takes no tenant: authentication
 * precedes tenant resolution, so `auth_users` has no policy and this works from
 * any context — including none.
 */
export const createAuthUser = async (db: Database, label = 'user'): Promise<string> => {
  const id = `${label}_${randomUUID().replaceAll('-', '').slice(0, 16)}`;

  await db.execute(sql`
    insert into auth_users (id, name, email)
    values (${id}, 'Test User', ${`${id}@example.com`})
  `);

  return id;
};
