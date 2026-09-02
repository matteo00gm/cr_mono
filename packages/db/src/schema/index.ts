/**
 * Drizzle schema — the typed surface over the migrated database.
 *
 * `drizzle.config.ts` generates every migration from what this file exports, so
 * a table that is not re-exported here does not exist as far as `db:generate` is
 * concerned: it will be silently absent from the SQL, and — worse — a later
 * generate will read the database as having drifted and try to drop it.
 */
export * from './memberships.js';
export * from './product-embeddings.js';
export * from './products.js';
export * from './tenant-domains.js';
export * from './tenants.js';
export * from './widget-keys.js';
