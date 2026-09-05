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
 *
 * **Moved here from `apps/api` by P0-53.** `audit()` records the actor, ip and
 * user-agent of whoever performed an action, and it lives in this package
 * because P0-52's last-OWNER guard and every other domain rule needs to write
 * audit rows — none of which can import an app. Threading an actor through
 * every call site instead was the alternative, and it fails the same way a
 * threaded logger does: the one path nobody threaded is the one that matters.
 *
 * Nothing here is HTTP-specific. `node:async_hooks` is not a framework, so the
 * P0-09 rule keeping this package free of HTTP and AWS still holds — the API
 * fills the context in from a request, and the worker will fill it from an SQS
 * message.
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

  /**
   * Where the request came from, for `audit_log.ip` (P0-53).
   *
   * The column is `inet`, which rejects a malformed address at write time — so
   * this stays optional rather than defaulting to something plausible. An audit
   * row that records a guessed address is worse than one that records none.
   */
  ip?: string;

  /** For `audit_log.user_agent`. Untrusted free text, and treated as such. */
  userAgent?: string;
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

/**
 * The caller, as an audit row records them.
 *
 * Read once at the point of writing rather than captured earlier, because the
 * user is only known after authentication and the tenant only after resolution
 * — an actor captured at the start of a request would be anonymous for every
 * action in it.
 */
export interface RequestActor {
  readonly userId: string | undefined;
  readonly ip: string | undefined;
  readonly userAgent: string | undefined;
  readonly tenantId: string | undefined;
}

export const getRequestActor = (): RequestActor => {
  const context = storage.getStore();

  return {
    userId: context?.userId,
    ip: context?.ip,
    userAgent: context?.userAgent,
    tenantId: context?.tenantId,
  };
};
