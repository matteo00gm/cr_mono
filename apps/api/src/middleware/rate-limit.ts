import { RateLimitedError } from '@catalogorosso/core';
import {
  isPlanCap,
  unresolvedLimitCheck,
  WIDGET_LIMITS,
  widgetLimitChecks,
  type RateLimiter,
  type WidgetEndpoint,
  type WidgetLimits,
} from '@catalogorosso/security';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv, WidgetTenant } from '../env.js';
import { bucketIp } from './ip-bucket.js';
import { clientIp } from './logger.js';

/**
 * Widget rate limiting (P2-04, §3.6).
 *
 * Every widget request draws from several buckets at once — its session, its
 * address, the tenant's minute, the endpoint, and for chat the tenant's month —
 * in one all-or-nothing `check`. Which buckets and how large lives in
 * `packages/security`; this applies the answer to HTTP.
 *
 * **Mounted after tenant resolution, and it refuses to run before it.** The
 * tenant is what every bucket but the session one is counted against, and it
 * comes from `(pk_, Origin)` (P2-07), never from the request. A limiter that ran
 * first would have nothing to count against — and a limiter that quietly counts
 * against nothing is one that has stopped applying without anybody noticing.
 *
 * **Headers go on a refusal only.** `X-RateLimit-Remaining` on every response
 * would publish, for the dimension that happened to be tightest, how busy a
 * winery's widget is — and on chat that dimension is often the month. A 429
 * says what a client needs to back off correctly and nothing more.
 */

/** The caller's address bucket for today: an HMAC, never the address (P2-04). */
const visitorBucket = (forwardedFor: string | undefined, ipSecret: string, nowMs: number): string =>
  bucketIp(clientIp(forwardedFor).ip, ipSecret, nowMs);

export class WidgetTenantUnresolvedError extends Error {
  constructor(endpoint: WidgetEndpoint) {
    super(
      `The ${endpoint} rate limit ran before the widget tenant was resolved. Mount it after ` +
        'the (pk_, Origin) resolution: without a tenant there is nothing to count against, ' +
        'and a limit that counts against nothing has silently stopped applying.',
    );
    this.name = 'WidgetTenantUnresolvedError';
  }
}

export interface WidgetLimitOptions {
  readonly limiter: RateLimiter;
  readonly endpoint: WidgetEndpoint;
  /**
   * What the daily address salt is derived from (`bucketIp`). Never logged and
   * never sent anywhere; losing it costs nothing but a reset of every address
   * bucket.
   */
  readonly ipSecret: string;
  /** Injected so the suite can trip one dimension at a time. */
  readonly limits?: WidgetLimits | undefined;
  /** Injected so the daily salt rotation is testable. */
  readonly now?: (() => number) | undefined;
}

export const limitWidgetRequest =
  ({
    limiter,
    endpoint,
    ipSecret,
    limits = WIDGET_LIMITS,
    now = Date.now,
  }: WidgetLimitOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const tenant = c.get('widgetTenant') as WidgetTenant | undefined;
    if (tenant === undefined) throw new WidgetTenantUnresolvedError(endpoint);

    const result = await limiter.check(
      widgetLimitChecks(
        {
          endpoint,
          tenantId: tenant.tenantId,
          plan: tenant.plan,
          ipBucket: visitorBucket(c.req.header('x-forwarded-for'), ipSecret, now()),
          // Set only by requireWidgetToken (P2-13), on a route that needs a session; absent otherwise.
          sessionId: c.get('widgetSessionId'),
        },
        limits,
      ),
    );

    if (!result.allowed) {
      c.header('Retry-After', String(result.retryAfterSec ?? 1));

      /*
       * The plan cap's numbers stay private. An `X-RateLimit-Limit` of 1000
       * tells anyone which plan a winery pays for, and §1.3 says a visitor is
       * never shown plan or billing details. `Retry-After` still goes out: the
       * start of next month is not a secret, and a client with no retry hint
       * retries immediately.
       */
      if (!isPlanCap(result.key)) {
        c.header('X-RateLimit-Limit', String(result.limit));
        c.header('X-RateLimit-Remaining', String(result.remaining));
        c.header('X-RateLimit-Reset', String(Math.ceil(result.resetAt.getTime() / 1000)));
      }

      throw new RateLimitedError('Too many requests. Try again shortly.');
    }

    await next();
  };

export type UnresolvedLimitOptions = Omit<WidgetLimitOptions, 'endpoint'>;

/**
 * The address limit that runs before the key and origin are resolved (review fix).
 *
 * **Mounted first on every widget route, ahead of `widgetCors`.** Resolution is
 * an uncached read per request, and CORS refuses an invented key only after
 * paying for it; every limit in `limitWidgetRequest` comes later still, because
 * each is counted against a tenant. Until this existed, a script cycling through
 * made-up keys cost one database read apiece with nothing to stop it.
 *
 * A refusal here carries no CORS headers, because nothing is known about the
 * caller yet, so a browser script cannot read it. It does not need to: the limit
 * sits well above what a real visitor does in a minute. It does carry
 * `Vary: Origin`, CORS's first rule, because it is still a response on a route
 * the edge may cache, and one CORS never saw.
 *
 * The check is itself a write to `rate_limit_buckets`, so this bounds the
 * expensive path rather than the request rate; the blunt per-address ceiling in
 * front of everything is P4-13's WAF rule.
 */
export const limitUnresolvedWidgetRequest =
  ({
    limiter,
    ipSecret,
    limits = WIDGET_LIMITS,
    now = Date.now,
  }: UnresolvedLimitOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const bucket = visitorBucket(c.req.header('x-forwarded-for'), ipSecret, now());
    const result = await limiter.check([unresolvedLimitCheck(bucket, limits)]);

    if (!result.allowed) {
      c.header('Vary', 'Origin', { append: true });
      c.header('Retry-After', String(result.retryAfterSec ?? 1));
      throw new RateLimitedError('Too many requests. Try again shortly.');
    }

    await next();
  };
