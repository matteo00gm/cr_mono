import { AsyncLocalStorage } from 'node:async_hooks';

/**
 * Per-request context, carried out of band (P0-55).
 *
 * Debugging a multi-tenant system without `tenant_id` on every log line is
 * guesswork, and the alternative to this is threading a logger through every
 * call site — which works right up until the one function nobody threaded it
 * into is the one that fails.
 *
 * `AsyncLocalStorage` and not a module-level variable: Lambda handles one
 * request at a time per container, but `sst dev` and the test suite do not, and
 * a mutable module global would attribute one tenant's log lines to another the
 * first time two requests overlap. That is a bug that never reproduces locally
 * and is unfalsifiable in production, so it is worth the machinery.
 */

export interface RequestContext {
  /** Generated per request. Returned to the caller so a report can be traced. */
  readonly requestId: string;
  /**
   * Mutable, because it is not known when the request starts.
   *
   * Tenant resolution reads `memberships` *after* authentication (P0-47), so
   * the first log lines of a request legitimately have no tenant. The store
   * object is mutated in place rather than re-run, so lines emitted before
   * resolution stay untagged and everything after it is tagged — an honest
   * record of what was known when.
   */
  tenantId?: string;
  /** Set by P0-45's session middleware, for the same reason. */
  userId?: string;
}

const storage = new AsyncLocalStorage<RequestContext>();

/** Runs `fn` with a fresh context. Everything `fn` awaits inherits it. */
export const runWithRequestContext = <T>(context: RequestContext, fn: () => T): T =>
  storage.run(context, fn);

/**
 * The active context, or `undefined` outside a request.
 *
 * `undefined` rather than a throw: the worker, migrations and the test suite
 * all legitimately run outside one, and a logger that throws when there is no
 * request is a logger that turns a background job into an outage.
 */
export const getRequestContext = (): RequestContext | undefined => storage.getStore();

/**
 * Attaches the resolved tenant to the current request.
 *
 * A no-op outside a request context rather than an error, for the reason above.
 * Returns whether it took effect, so a caller that genuinely requires context
 * can check rather than assume.
 */
export const setRequestTenant = (tenantId: string): boolean => {
  const context = storage.getStore();
  if (!context) return false;
  context.tenantId = tenantId;
  return true;
};

export const setRequestUser = (userId: string): boolean => {
  const context = storage.getStore();
  if (!context) return false;
  context.userId = userId;
  return true;
};
