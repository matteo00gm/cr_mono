import { getRequestContext, runWithRequestContext, type RequestContext } from '@catalogorosso/core';
import { randomUUID } from 'node:crypto';
import process from 'node:process';
import type { MiddlewareHandler } from 'hono';
import { routePath } from 'hono/route';
import { pino, type Logger, type LoggerOptions } from 'pino';

import { redactLogObject, scrubString } from '@catalogorosso/security';

/**
 * Structured logging (P0-55).
 *
 * JSON at `info`, one line per request, with `requestId` and — once P0-47 has
 * resolved it — `tenantId` on every line. CloudWatch Logs Insights can query
 * JSON fields directly, so `filter tenantId = "…"` is the difference between
 * answering "what did this seller see" in seconds and grepping a text log.
 */

/**
 * No transport, no pretty-printing, ever.
 *
 * `pino-pretty` spawns a worker thread. In Lambda that costs cold-start time
 * for output nobody reads — CloudWatch stores the line either way — and worse,
 * a worker whose writes have not flushed when the invocation freezes loses the
 * log lines for the request that most needed them. Plain stdout is what the
 * Lambda runtime is built to capture.
 */
export const loggerOptions: LoggerOptions = {
  level: process.env.LOG_LEVEL ?? 'info',

  // ISO timestamps rather than pino's default epoch millis: these lines are
  // read by humans next to CloudWatch's own timestamps far more often than
  // they are parsed by a machine that cares about the extra bytes.
  timestamp: pino.stdTimeFunctions.isoTime,

  /**
   * The allowlist redaction (P0-56), applied to the merged object of every
   * single log call.
   *
   * `formatters.log` is the only hook that sees every logged object, which is
   * why the redaction lives here rather than in per-key serializers: a
   * serializer protects the keys somebody registered one for, and the next key
   * added leaks by default — the exact failure mode an allowlist exists to
   * prevent.
   */
  formatters: { log: redactLogObject },

  /**
   * Pino's default `err` serializer, deliberately switched off.
   *
   * Verified by probing the pinned build: `formatters.log` runs *before*
   * serializers, and the default `err` serializer then rewrites the key from
   * the original `Error` — so it silently discards whatever the formatter
   * produced and emits an unredacted `message` and `stack`. With the redaction
   * in place and this left at its default, a connection string in a driver
   * error still reaches CloudWatch.
   *
   * The identity function hands the formatter's own output straight through;
   * `redact.ts#serialiseError` has already reduced the error to type, scrubbed
   * message, scrubbed stack and cause.
   */
  serializers: { err: (value: unknown) => value },

  /**
   * The message string, which `formatters.log` never sees.
   *
   * Confirmed the same way: `msg` is assembled after the formatter runs, so a
   * `logger.info('failed with token sk_live_…')` would be published verbatim.
   * This hook is the only place the message argument can be reached.
   */
  hooks: {
    logMethod(args, method) {
      method.apply(
        this,
        args.map((arg) => (typeof arg === 'string' ? scrubString(arg) : arg)) as typeof args,
      );
    },
  },

  /**
   * The request context, injected into every line without any call site
   * knowing about it.
   *
   * This is the entire reason the AsyncLocalStorage exists: `logger.info('x')`
   * anywhere in a request — in a repository function five layers down that has
   * never heard of HTTP — carries the tenant that request belongs to.
   */
  mixin: () => {
    const context = getRequestContext();
    if (!context) return {};
    return {
      requestId: context.requestId,
      ...(context.tenantId === undefined ? {} : { tenantId: context.tenantId }),
      ...(context.userId === undefined ? {} : { userId: context.userId }),
    };
  },
};

/**
 * The process logger.
 *
 * The options are exported separately so the suite can build a second logger
 * over the same configuration writing to a capture stream. Spying on this
 * object's methods would assert that a call happened; it would not assert that
 * `mixin` actually put the tenant on the line, which is the only property here
 * worth having.
 */
export const logger: Logger = pino(loggerOptions);

/**
 * The single client address, or nothing.
 *
 * A multi-entry `x-forwarded-for` cannot be trusted without knowing which hops
 * are ours (the same problem P0-46 records against the rate limiter), and a
 * value that is not an address at all would be refused by the `inet` column.
 * Both cases resolve to no address rather than a wrong one.
 */
const clientIp = (header: string | undefined): { ip?: string } => {
  if (header === undefined) return {};

  const entries = header.split(',').map((entry) => entry.trim());
  const [only] = entries;

  return entries.length === 1 && only !== undefined && /^[0-9a-fA-F.:]+$/.test(only)
    ? { ip: only }
    : {};
};

/**
 * Present or absent, never `undefined` — `exactOptionalPropertyTypes` treats
 * "the key is there holding undefined" as a different thing from "no key", and
 * only the second is what an absent header means.
 */
const userAgent = (header: string | undefined): { userAgent?: string } =>
  header === undefined ? {} : { userAgent: header };

/** The header the request id is echoed on, so a caller can quote it in a report. */
export const REQUEST_ID_HEADER = 'x-request-id';

/**
 * Opens a request context, logs the completion line, echoes the request id.
 *
 * **Must be registered before any route** — Hono matches handlers in
 * registration order, so a `use()` below a `get()` never runs (P0-54). A
 * logger registered in the wrong place produces a suite that passes and a
 * production system with no logs.
 *
 * The logger is a parameter so the suite can hand in one writing to an array
 * and assert on the line that was actually emitted. Defaulting to the process
 * logger keeps every call site free of the seam.
 */
export const requestContext =
  (log: Logger = logger): MiddlewareHandler =>
  async (c, next) => {
    /*
     * Generated here, never taken from the request.
     *
     * An `X-Request-Id` from the caller is attacker-controlled: it lets one
     * client stamp every request with the same id, or reuse the id from
     * somebody else's error report, and both defeat the only thing this value
     * is for. AWS's own `x-amzn-trace-id` is logged alongside for correlation
     * with the edge, because that one is not ours to invent.
     */
    const context: RequestContext = {
      requestId: randomUUID(),

      /*
       * Captured here so `audit()` can record them without every call site
       * knowing about HTTP (P0-53).
       *
       * `x-forwarded-for` is the same header the rate limiter resolves callers
       * by, and it can carry a list once a proxy appends to it — so only a
       * single, well-formed-looking entry is kept. `audit_log.ip` is `inet` and
       * rejects anything else at write time, and an audit row recording a
       * guessed address is worse than one recording none.
       */
      ...clientIp(c.req.header('x-forwarded-for')),
      ...userAgent(c.req.header('user-agent')),
    };

    await runWithRequestContext(context, async () => {
      const startedAt = Date.now();

      // Set before `next()`, so it is present even on the error path — the
      // request id is most useful on exactly the responses that failed.
      c.header(REQUEST_ID_HEADER, context.requestId);

      await next();

      log.info(
        {
          method: c.req.method,
          /*
           * The route *template*, not the raw URL: `/v1/products/:id` groups,
           * where `/v1/products/9f2c…` makes every request its own unique
           * string and any aggregate query over the logs useless. It also
           * keeps resource ids out of the line as a side effect.
           *
           * The `hono/route` helper rather than `c.req.routePath`, which is
           * deprecated in 4.13.5 and reads the same field. Called after
           * `next()`, so `routeIndex` points at the handler that actually ran.
           */
          route: routePath(c),
          status: c.res.status,
          durationMs: Date.now() - startedAt,
          traceId: c.req.header('x-amzn-trace-id'),
        },
        'request',
      );
    });
  };
