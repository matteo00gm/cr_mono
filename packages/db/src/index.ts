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
