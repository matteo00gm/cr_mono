import { widgetConfigResponse, widgetSurfaceResponse } from '@catalogorosso/api-client';
import {
  planCapCheck,
  publicRoute,
  quotaStateOf,
  type MonthlyCheck,
  type RateLimiter,
  type RouteAccess,
} from '@catalogorosso/security';
import { Hono } from 'hono';

import type { AppEnv } from '../env.js';
import { routeKey } from '../middleware/capability.js';
import { widgetCors, type RejectedWidgetRequest, type WidgetResolver } from '../middleware/cors.js';
import { limitWidgetRequest } from '../middleware/rate-limit.js';
import { WIDGET_PREFIX } from '../routes.js';
import { widgetConfigFor } from '../widget-config.js';
import type { RouteDoc } from './dashboard.js';

/**
 * The widget surface — `/v1/widget/*` (P0-54).
 *
 * Public, called from sellers' own sites, and authenticated by origin-bound
 * tokens rather than by session cookies (§3.4). It gets the per-request CORS
 * handler that the dashboard must never have (P2-08), and rate limiting keyed
 * on the visitor rather than on a user (P2-04).
 *
 * A separate `Hono` instance for the same reason the dashboard is one, read in
 * the other direction: a CORS middleware mounted on a shared root would apply to
 * the authenticated dashboard endpoints as well, which is how a cross-origin
 * page ends up able to read a seller's catalogue.
 *
 * **Better Auth is never mounted here, and no route on this surface reads a
 * session cookie.** Two authentication systems on one API is exactly where
 * confusion bugs live, so P0-46 asserts the pair explicitly in both directions:
 * an auth cookie presented here grants nothing, and a widget token presented to
 * the dashboard grants nothing.
 */

export interface WidgetDependencies {
  /** `resolveTenantByKeyAndOrigin` (P2-07). */
  readonly resolve: WidgetResolver;
  readonly limiter: RateLimiter;
  /**
   * How much of a window has been spent, without spending any —
   * `createRateLimiter().peek` (P2-10). The config route reads the month's
   * plan cap through it, so a widget is told `exceeded` by the same counter
   * that refuses its messages.
   */
  readonly readUsage: (check: MonthlyCheck) => Promise<number>;
  /** What the daily address salt is derived from (P2-04). */
  readonly ipSecret: string;
  readonly environment?: 'production' | 'development' | undefined;
  /** Where refusals go; P2-16 supplies the `security_events` writer. */
  readonly onRejected?: ((event: RejectedWidgetRequest) => Promise<void>) | undefined;
}

/**
 * The widget with nothing behind it.
 *
 * Its routes still exist, so the boot check sees them declared, and answering
 * them throws — the `unconfiguredMembers` shape. A widget surface that answered
 * without resolution would be serving config with no CORS decision at all,
 * which must fail loudly rather than work.
 */
export class WidgetNotConfiguredError extends Error {
  constructor() {
    super(
      'No widget dependencies were supplied to createApp, so the widget cannot resolve a ' +
        'tenant or apply its limits. This is a wiring bug at the composition root.',
    );
    this.name = 'WidgetNotConfiguredError';
  }
}

/**
 * A minute, publicly (P2-10).
 *
 * Nothing in the response is private, which is the only reason it may be cached
 * at all; `infra/widget-cache.ts` holds the edge to the same minute and keys it
 * on `Origin` and the public key. Set on a 200 only — a refusal is never cached.
 */
export const WIDGET_CONFIG_CACHE_CONTROL = 'public, max-age=60';

const CONFIG_PATH = '/config';

export const createWidgetApp = (widget?: WidgetDependencies): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /** See the note on the dashboard surface marker. */
  app.get('/', (c) => c.json({ surface: 'widget' as const }));

  if (widget === undefined) {
    app.on(['GET', 'OPTIONS'], CONFIG_PATH, () => {
      throw new WidgetNotConfiguredError();
    });

    return app;
  }

  /**
   * The widget's public configuration (P2-10).
   *
   * **The order is the security property.** CORS first, because it is what
   * resolves the tenant from `(pk_, Origin)` and refuses everything else; the
   * limit second, because it counts against the tenant CORS resolved; the
   * handler last, reading only what those two established. A preflight is
   * answered by CORS and never reaches the limit or the handler.
   */
  app.on(
    ['GET', 'OPTIONS'],
    CONFIG_PATH,
    widgetCors({
      resolve: widget.resolve,
      onRejected: widget.onRejected,
      environment: widget.environment,
    }),
    limitWidgetRequest({ limiter: widget.limiter, endpoint: 'config', ipSecret: widget.ipSecret }),
    async (c) => {
      const tenant = c.get('widgetTenant');
      const cap = planCapCheck(tenant.tenantId, tenant.plan);
      const used = await widget.readUsage(cap);

      c.header('Cache-Control', WIDGET_CONFIG_CACHE_CONTROL);

      return c.json(widgetConfigFor(tenant, quotaStateOf(used, cap.limit)));
    },
  );

  return app;
};

/**
 * Every documented widget route, keyed by `METHOD <mounted path>` (P0-49, P0-62).
 *
 * The widget's counterpart to `DASHBOARD_ROUTES`: the boot check reads the
 * access, and `scripts/gen-openapi.mjs` publishes the rest as the public widget
 * reference, which until now was empty.
 */
export const WIDGET_ROUTES: ReadonlyMap<string, RouteDoc> = new Map<string, RouteDoc>([
  [
    routeKey('GET', WIDGET_PREFIX),
    {
      access: publicRoute(
        'Surface marker. Reports which app answered and nothing else - no tenant, no ' +
          'key, no data. P0-46 uses it to prove the two surfaces are distinct.',
      ),
      summary: 'Identify the widget surface',
      description:
        'Returns the name of the route surface that handled the request, so a caller - ' +
        'or a test - can prove which application answered. Carries no tenant or catalogue data.',
      example: { surface: 'widget' },
      response: widgetSurfaceResponse,
    },
  ],
  [
    routeKey('GET', `${WIDGET_PREFIX}${CONFIG_PATH}`),
    {
      access: publicRoute(
        'Public and world-readable by design (§1.2): no token and no session, because the ' +
          'widget fetches it before a visitor has done anything. What gates it is the ' +
          '(pk_, Origin) pair - refused with a bare 403 unless the key and a verified origin ' +
          'agree on one tenant - and the rate limits. It returns nothing a competitor could ' +
          'use: no tenant id, no plan, no counts.',
      ),
      summary: "The widget's public configuration",
      description:
        'Called by the loader with `?key=<public key>` before anything else loads. Answers ' +
        'whether the widget is enabled, how it looks, and whether this month is nearly ' +
        'spent - as `ok`, `near` or `exceeded`, never as a number. Refused with 403 and no ' +
        "CORS headers unless the key and the request's Origin belong to one tenant. Cached " +
        'publicly for sixty seconds, varying on Origin.',
      example: {
        status: 'ACTIVE',
        locale: 'it',
        theme: { primaryColor: '#7b1e3a', position: 'bottom-right', avatarUrl: null },
        welcomeMessage: 'Ciao! Sono il sommelier di questa cantina. Che vino stai cercando?',
        cartUrl: '/cart',
        quotaState: 'ok',
      },
      response: widgetConfigResponse,
    },
  ],
]);

/**
 * Access for the widget surface (P0-49): every documented route, and the
 * config route's CORS preflight.
 *
 * The preflight is declared and not documented. It is answered by the identical
 * resolution as the request it precedes, and a reference entry for it would be
 * describing the browser rather than the API.
 */
export const WIDGET_ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = new Map<string, RouteAccess>([
  ...[...WIDGET_ROUTES].map(([key, doc]): [string, RouteAccess] => [key, doc.access]),
  [
    routeKey('OPTIONS', `${WIDGET_PREFIX}${CONFIG_PATH}`),
    publicRoute(
      'The CORS preflight for the config route. Answered by the same (pk_, Origin) ' +
        'resolution as the request it precedes, with no body and nothing else.',
    ),
  ],
]);
