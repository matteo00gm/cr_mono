import { AsyncLocalStorage } from 'node:async_hooks';
import { sql } from 'drizzle-orm';
import { type Database, getDb } from './client.js';

/**
 * Tenant isolation and Row Level Security (RLS) helper (P0-19).
 *
 * This is the single sanctioned entry point for all tenant-scoped database access.
 *
 * Crucial guarantees:
 * 1. `set_config('app.tenant_id', tenantId, true)` — the third argument `true`
 *    makes the setting transaction-local (`SET LOCAL`), preventing tenant context
 *    from leaking across pooled connections into subsequent requests.
 * 2. `tenantId` is strictly validated as a UUID before opening a transaction.
 * 3. Parameterised query (`${tenantId}`) prevents SQL injection into RLS context.
 * 4. Nested `withTenant` calls are detected and rejected to prevent accidental
 *    tenant context swapping within a single workflow.
 */

/**
 * Shape only — deliberately not the version and variant bits.
 *
 * The earlier pattern pinned the version nibble to 1-5 and the variant to
 * 8/9/a/b, which describes the UUIDs `gen_random_uuid()` happens to emit today
 * and rejects the ones it would emit tomorrow: a v7 id, chosen for index
 * locality, fails validation and every request for that tenant 500s. The
 * database is the authority on what it generated, so what is checked here is
 * the only thing that matters to `set_config` — that the value is a
 * well-formed UUID and cannot be anything else.
 */
const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const tenantStorage = new AsyncLocalStorage<{ readonly tenantId: string }>();

export class InvalidTenantIdError extends Error {
  constructor(invalidId: string) {
    super(`Invalid tenant ID "${invalidId}". Tenant ID must be a valid UUID.`);
    this.name = 'InvalidTenantIdError';
  }
}

export class NestedTenantContextError extends Error {
  constructor(activeTenantId: string, requestedTenantId: string) {
    super(
      `Cannot nest withTenant("${requestedTenantId}") inside active withTenant("${activeTenantId}") context. ` +
        'Tenant context must remain strictly isolated.',
    );
    this.name = 'NestedTenantContextError';
  }
}

export type DbTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];

/**
 * Executes a callback within a tenant-scoped transaction.
 * Sets `app.tenant_id` locally for the duration of the transaction.
 */
export const withTenant = async <T>(
  tenantId: string,
  fn: (tx: DbTransaction) => Promise<T>,
  db: Database = getDb(),
): Promise<T> => {
  if (!tenantId || !UUID_REGEX.test(tenantId)) {
    throw new InvalidTenantIdError(tenantId);
  }

  const currentContext = tenantStorage.getStore();
  if (currentContext) {
    throw new NestedTenantContextError(currentContext.tenantId, tenantId);
  }

  return tenantStorage.run({ tenantId }, async () => {
    return db.transaction(async (tx) => {
      // SET LOCAL via third parameter `true` (transaction-local)
      await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
      return fn(tx);
    });
  });
};

/**
 * Returns the currently active tenantId from AsyncLocalStorage if inside a withTenant context.
 */
export const getCurrentTenantId = (): string | undefined => {
  return tenantStorage.getStore()?.tenantId;
};
