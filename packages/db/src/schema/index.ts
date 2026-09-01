/**
 * Drizzle schema — the typed surface over the migrated database.
 *
 * Empty until P0-22 adds `tenants`. It exists now because `drizzle.config.ts`
 * needs a schema entry point to generate migrations from, and because the
 * import path is what every later table module is re-exported through.
 */
export {};
