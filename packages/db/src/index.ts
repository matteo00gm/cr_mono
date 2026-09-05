/**
 * Public surface of `@catalogorosso/db`.
 *
 * `withTenant` is the only sanctioned way to reach the database (P0-19), and
 * that has to hold at the *export* surface, not just the import one. Re-exporting
 * `getDb`/`getSql`/`createDbClient` from here would let any app write
 * `import { getDb } from '@catalogorosso/db'` and issue queries with no tenant
 * context — no dependency rule can catch that, because the app would be
 * importing this package rather than the driver.
 *
 * The connection factory stays internal to the package. When a genuinely
 * un-scoped path is needed — migrations as `app_migrate`, or the Better Auth
 * adapter reading `auth_*` tables before a tenant is known (§P0-45) — it gets
 * its own narrowly-named export with a written reason, rather than a general
 * accessor that erodes into the default.
 */
export {
  getCurrentTenantId,
  InvalidTenantIdError,
  NestedTenantContextError,
  withTenant,
  type DbTransaction,
} from './with-tenant.js';

/**
 * The user-scoped read for tenant resolution (P0-47).
 *
 * Exported from here alongside `withTenant` rather than hidden behind a
 * subpath, because it is **not** an exception to the rule above — it is a
 * second scoped context, and everything it can reach is still under RLS. The
 * `memberships` policy admits `user_id = app.user_id` on read and nothing else
 * does, so this context can see exactly the caller's own membership rows.
 * Contrast `@catalogorosso/db/auth`, which really does hand out an un-scoped
 * connection and is therefore gated by the P0-09 rule.
 */
export { InvalidUserIdError, NestedUserContextError, withUser } from './with-user.js';

/**
 * The membership read itself, so no app has to write the query.
 *
 * It lives here rather than in `apps/api` because writing it there would mean
 * the app importing `drizzle-orm`, which the P0-09 rule forbids — and the right
 * answer to that was to put the query where queries belong, not to add an
 * exception. The decision made *with* these rows stays in `packages/core`,
 * which has no database at all.
 */
export { readMembershipsForUser, type MembershipRole, type UserMembership } from './memberships.js';

/**
 * The audit insert (P0-53).
 *
 * Same reasoning as the membership read above: the statement lives in this
 * package so no app or domain module has to import a driver. What gets
 * recorded, and what is scrubbed out of it, stays in `packages/core`.
 */
export { insertAuditRow, type AuditRow } from './audit.js';

export type { Database } from './client.js';

/**
 * The request and response contracts (P0-42).
 *
 * Exported from here rather than reached for by deep import, so the widget, the
 * dashboard and the API all validate against the same shapes — the point of
 * deriving them at all. They carry no connection and open nothing, so they do
 * not weaken the `withTenant`-only rule above.
 */
export * from './contracts.js';

/**
 * The deploy-time path (P0-21b), and the one narrowly-named un-scoped export
 * this file's header anticipates.
 *
 * These apply bootstrap and migrations as the roles that own the schema, before
 * any tenant row exists — there is no tenant context to carry and no policy for
 * one to satisfy, so `withTenant` would have nothing to say. Exported because
 * both a deploy and the P0-44 harness need them, and a second copy of the
 * applying logic is exactly what the P0-21 grant bug came from.
 */
export {
  applyBootstrap,
  applyMigrations,
  revertMigrations,
  withRole,
  type BootstrapRole,
} from './deploy.js';
