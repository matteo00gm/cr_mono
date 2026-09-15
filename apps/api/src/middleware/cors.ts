import { ForbiddenError } from '@catalogorosso/core';
import type { WidgetResolution } from '@catalogorosso/db';
import { normalizeOrigin } from '@catalogorosso/security';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';
import { logger } from './logger.js';

/**
 * Dynamic CORS for the widget surface (P2-08, §3.1).
 *
 * **The most-read security code in the repository, and the place the classic
 * multi-tenancy bug lives.** Every decision is made per request from the
 * verified-origin set: there is no static allowlist and no environment variable
 * listing domains. The key names a tenant, the `Origin` names a site, and a
 * response is shareable with that site only when the two agree (P2-07).
 *
 * The five rules, each asserted in the suite:
 *
 * 1. **`Vary: Origin` on every response, refusals included.** Without it a CDN
 *    can cache one tenant's allow-header and serve it to another origin — the
 *    single most common real-world CORS multi-tenancy bug.
 * 2. **Exact string equality** against the verified set, reached through
 *    `normalizeOrigin` and an exact comparison in SQL. Never a regex, never
 *    `startsWith`, never `endsWith`.
 * 3. **A refusal carries no CORS headers at all** — not an empty one.
 * 4. **`Access-Control-Allow-Credentials: false`**: the widget authenticates
 *    with bearer tokens and never cookies, which removes CSRF from this surface.
 * 5. **A preflight runs the identical resolution**, and `Max-Age` is short so a
 *    removed domain stops working promptly.
 *
 * **CORS is a browser control, and it does nothing against `curl`.** It
 * protects visitors' browsers and stops casual widget theft. A script that
 * sends no `Origin`, or any `Origin` it likes, is refused here only because this
 * middleware refuses what it cannot verify; what actually stops server-side
 * abuse is the session token (§3.4) and the rate limits (§3.6). Nobody should
 * read this file as the whole defence.
 *
 * Attached per route rather than with `use('*')`, so the surface marker and
 * unknown paths keep their own answers, and always before the handler it guards
 * (P0-54).
 */

/** The query parameter the loader sends the public key in (§1.2). */
export const WIDGET_KEY_PARAM = 'key';

/** Short, so a domain removal takes effect within minutes rather than a day. */
export const PREFLIGHT_MAX_AGE_SEC = 600;

const ALLOWED_METHODS = 'GET, POST, OPTIONS';
const ALLOWED_HEADERS = 'Authorization, Content-Type';

/**
 * What a widget script is allowed to read from a cross-origin response.
 *
 * The rate-limit headers, because the widget's `RATE_LIMITED` state counts down
 * from `Retry-After` (§1.3). Nothing else is exposed.
 */
const EXPOSED_HEADERS = 'Retry-After, X-RateLimit-Limit, X-RateLimit-Remaining, X-RateLimit-Reset';

/**
 * One message for every refusal.
 *
 * A missing origin, a bad key and a key used from the wrong site must be
 * indistinguishable to the caller, or this becomes an oracle for which keys
 * exist and which sites own them. The distinction is for our logs (P2-16).
 */
export const WIDGET_REFUSED = 'This widget is not available on this site.';

export interface RejectedWidgetRequest {
  /** The `security_event_type` P2-16 records. */
  readonly type: 'UNAUTHORIZED_ORIGIN' | 'INVALID_KEY';
  /** Present only when a real key named a tenant — the theft signal (§3.2). */
  readonly tenantId?: string | undefined;
  /** As the browser sent it, verbatim: what was claimed is the evidence. */
  readonly origin: string | undefined;
  readonly publicKey: string | undefined;
}

export type WidgetResolver = (publicKey: string, origin: string) => Promise<WidgetResolution>;

export interface WidgetCorsOptions {
  /** `resolveTenantByKeyAndOrigin` (P2-07); injected so the suite needs no database. */
  readonly resolve: WidgetResolver;
  /**
   * Where a refusal is reported. P2-16 supplies the `security_events` writer;
   * until then the default logs the refusal's type.
   *
   * **It can never fail a request**, synchronously or not: a security log that
   * errors must not become a way to deny service to a seller's visitors.
   */
  readonly onRejected?: ((event: RejectedWidgetRequest) => Promise<void>) | undefined;
  /** `development` admits `http:` and `localhost` origins (P2-05). */
  readonly environment?: 'production' | 'development' | undefined;
}

/**
 * The default report: the refusal's type and nothing else.
 *
 * Not the origin and not the key. Both would need names in the P0-56 redaction
 * allowlist, which opens a name at every depth for every caller, and P2-16's
 * table is the place that is meant to hold them.
 */
const logRejection = (event: RejectedWidgetRequest): Promise<void> => {
  logger.warn({ kind: 'widget_request_refused', type: event.type }, 'a widget request was refused');
  return Promise.resolve();
};

/** Reports a refusal without ever letting the report affect the response. */
const report = (
  onRejected: (event: RejectedWidgetRequest) => Promise<void>,
  event: RejectedWidgetRequest,
): void => {
  const unrecorded = () => {
    logger.warn(
      { kind: 'widget_refusal_unrecorded', type: event.type },
      'a refusal went unrecorded',
    );
  };

  try {
    onRejected(event).catch(unrecorded);
  } catch {
    unrecorded();
  }
};

export const widgetCors =
  ({
    resolve,
    onRejected = logRejection,
    environment = 'production',
  }: WidgetCorsOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    // Rule 1: before any decision, so no path out of here can miss it.
    c.header('Vary', 'Origin', { append: true });

    const sentOrigin = c.req.header('origin');
    const publicKey = c.req.query(WIDGET_KEY_PARAM);

    const refuse = (event: Omit<RejectedWidgetRequest, 'origin' | 'publicKey'>): never => {
      report(onRejected, { ...event, origin: sentOrigin, publicKey });
      // Rule 3: nothing but `Vary` has been set, and nothing else will be.
      throw new ForbiddenError(WIDGET_REFUSED);
    };

    if (sentOrigin === undefined) return refuse({ type: 'UNAUTHORIZED_ORIGIN' });

    const normalized = normalizeOrigin(sentOrigin, { environment });
    if (!normalized.ok) return refuse({ type: 'UNAUTHORIZED_ORIGIN' });

    if (publicKey === undefined || publicKey === '') return refuse({ type: 'INVALID_KEY' });

    // Rule 2: the comparison is `normalizeOrigin` plus an exact match in SQL.
    const resolution = await resolve(publicKey, normalized.origin);

    if (!resolution.found) {
      return resolution.reason === 'origin_mismatch'
        ? refuse({ type: 'UNAUTHORIZED_ORIGIN', tenantId: resolution.tenantId })
        : refuse({ type: 'INVALID_KEY' });
    }

    /*
     * An exact echo of the verified origin, never `*` and never the raw header.
     * A browser compares this with its own serialised origin, so an `Origin` that
     * only normalised onto a verified one — `https://winery.com.` — gets a value
     * that does not match it, and the browser refuses the response. Fail closed.
     */
    c.header('Access-Control-Allow-Origin', normalized.origin);
    c.header('Access-Control-Allow-Credentials', 'false');

    c.set('widgetTenant', {
      tenantId: resolution.tenantId,
      plan: resolution.plan,
      status: resolution.status,
      locale: resolution.locale,
    });

    // Rule 5: the same resolution answered the preflight, so it gets the same answer.
    if (c.req.method === 'OPTIONS') {
      c.header('Access-Control-Allow-Methods', ALLOWED_METHODS);
      c.header('Access-Control-Allow-Headers', ALLOWED_HEADERS);
      c.header('Access-Control-Max-Age', String(PREFLIGHT_MAX_AGE_SEC));
      return c.body(null, 204);
    }

    c.header('Access-Control-Expose-Headers', EXPOSED_HEADERS);
    await next();
  };
