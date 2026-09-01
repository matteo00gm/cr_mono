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
