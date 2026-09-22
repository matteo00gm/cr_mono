import {
  widgetChatEvent,
  widgetConfigResponse,
  widgetSessionResponse,
  widgetSurfaceResponse,
} from '@catalogorosso/api-client';
import {
  planCapCheck,
  publicRoute,
  quotaStateOf,
  type MonthlyCheck,
  type RateLimiter,
  type RouteAccess,
  type WidgetEndpoint,
} from '@catalogorosso/security';
import type { WidgetTokenKeys } from '@catalogorosso/security/tokens';
import { InvalidRequestError } from '@catalogorosso/core';
import { createHash } from 'node:crypto';
import { z } from 'zod';
import { Hono, type Context, type Handler, type MiddlewareHandler } from 'hono';
import { streamSSE } from 'hono/streaming';

import type { AppEnv } from '../env.js';
import { QuotaExceededError, type ChatPort } from '../chat.js';
import { requireWidgetToken, type RejectedWidgetToken } from '../middleware/widget-auth.js';
import { routeKey } from '../middleware/capability.js';
import { widgetCors, type RejectedWidgetRequest, type WidgetResolver } from '../middleware/cors.js';
import { clientIp, logger } from '../middleware/logger.js';
import { limitUnresolvedWidgetRequest, limitWidgetRequest } from '../middleware/rate-limit.js';
import { WIDGET_PREFIX } from '../routes.js';
import { widgetConfigFor } from '../widget-config.js';
import { mintWidgetSession } from '../widget-session.js';
import { bearerTokenOf, type TokenRevocationCheck } from '../widget-token.js';
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
  /**
   * The session token keyset, loaded once per container (P2-11, P2-12). Absent,
   * the session route answers with a wiring error: restrictive, since nothing is
   * minted without a key.
   */
  readonly tokenKeys?: (() => Promise<WidgetTokenKeys>) | undefined;
  /**
   * Whether a token was revoked — `isTokenRevoked` (P2-12a). Absent, a previous
   * token is ignored and every mint starts a fresh session: restrictive, since
   * continuing without asking could revive a revoked token's conversation.
   */
  readonly isTokenRevoked?: TokenRevocationCheck | undefined;
  /** Where a refused *token* goes (P2-16). Separate from `onRejected`, which is CORS's. */
  readonly onTokenRejected?: ((event: RejectedWidgetToken) => Promise<void>) | undefined;
  /**
   * Answers one question (P2-29). Absent, `/chat` reports a wiring error rather
   * than a silence: a widget that streams nothing and errors nothing is a
   * widget nobody can debug.
   */
  readonly chat?: ChatPort | undefined;
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

/** The session route was reached on a stage with no keyset — a wiring or operator gap, never a caller's fault. */
export class WidgetTokenKeysNotConfiguredError extends Error {
  constructor() {
    super(
      'No widget token keyset was supplied, so no session can be minted. Set WidgetTokenKeys ' +
        'with `node scripts/widget-token-key.mjs | sst secret set WidgetTokenKeys` (P2-11).',
    );
    this.name = 'WidgetTokenKeysNotConfiguredError';
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
const SESSION_PATH = '/session';
const CHAT_PATH = '/chat';

/**
 * The only thing a chat body carries (P0-48).
 *
 * `.strict()`: the tenant, the origin and the session id all come from guards
 * that established them, so a body offering any of them is a caller trying
 * something rather than a client sending too much.
 */
const chatRequest = z.object({ message: z.string().trim().min(1).max(500) }).strict();

export const CHAT_BODY_EXPECTED = 'Send a JSON body with a message.';

/** A body, or null when there is not one — the dashboard surface's argument, on this surface. */
const readChatJson = async (c: { req: { json: () => Promise<unknown> } }): Promise<unknown> => {
  try {
    return await c.req.json();
  } catch {
    return null;
  }
};

/**
 * The visitor, as §3.9 allows them to be recorded: a salted hash, never an
 * address. Null when no secret is configured, which is a local run rather than
 * a deployment.
 */
const visitorHashOf = (c: Context<AppEnv>, ipSecret: string): string | null => {
  const { ip } = clientIp(c.req.header('x-forwarded-for'));

  return ip === undefined ? null : createHash('sha256').update(`${ip}|${ipSecret}`).digest('hex');
};

/**
 * What an SSE response must carry through CloudFront (P2-29).
 *
 * **`no-transform` is the load-bearing one.** It tells CloudFront not to
 * compress or otherwise rewrite the body, and compression is itself a buffering
 * step — a buffered stream is indistinguishable from a slow one, so
 * time-to-first-token silently becomes total-generation-time and the widget
 * feels broken rather than alive.
 *
 * `X-Accel-Buffering` does nothing at CloudFront and disables buffering in
 * nginx, which sits in front of some sellers' setups.
 */
export const SSE_HEADERS: Readonly<Record<string, string>> = {
  'Content-Type': 'text/event-stream',
  'Cache-Control': 'no-cache, no-store, no-transform',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** How often an idle stream says something, so an intermediary does not drop it. */
export const HEARTBEAT_MS = 15_000;

/**
 * A token is never held by a cache between the widget and us (P2-12). The
 * `/v1/*` behaviour caches nothing already; this says so on the response too,
 * for every cache that is not ours.
 */
export const WIDGET_SESSION_CACHE_CONTROL = 'no-store';

/** A guarded widget route: the methods it answers, where, and which limits it counts against. */
interface GuardedRoute {
  readonly methods: readonly ('GET' | 'POST' | 'OPTIONS')[];
  readonly path: string;
  readonly endpoint: WidgetEndpoint;
  /**
   * Whether a verified session token is required (P2-13).
   *
   * Placed between CORS and the tenant's limits, which is the only order that
   * works: CORS establishes the tenant and origin the token is checked against,
   * and the limits need the session id the token carries.
   */
  readonly session?: boolean | undefined;
}

/**
 * Mounts a widget route behind the three guards every one of them needs, in
 * the only safe order (review fix; the invariant in `AGENTS.md`).
 *
 * 1. **The address limit**, because it is the only thing that can run before a
 *    tenant is known, and resolving one is a query.
 * 2. **CORS**, because it resolves the tenant from `(pk_, Origin)` and refuses
 *    everything else.
 * 3. **The tenant's limits**, because they count against the tenant CORS resolved.
 *
 * Then the handler, reading only what those established. A preflight is counted
 * by the address limit and answered by CORS, and never reaches the tenant's
 * limits or the handler.
 *
 * **The only way a widget route should be mounted.** A route wired by hand can
 * drop a guard or reorder two, and every one of its own tests still passes;
 * `widget-route-guards.test.ts` walks the route table and fails for any route
 * that is not behind all three, which is what holds P2-12 and P2-29 to it.
 */
const mountGuarded = (
  app: Hono<AppEnv>,
  widget: WidgetDependencies,
  { methods, path, endpoint, session = false }: GuardedRoute,
  handler: Handler<AppEnv>,
): void => {
  const guards: MiddlewareHandler<AppEnv>[] = [
    limitUnresolvedWidgetRequest({ limiter: widget.limiter, ipSecret: widget.ipSecret }),
    widgetCors({
      resolve: widget.resolve,
      onRejected: widget.onRejected,
      environment: widget.environment,
      // So a recorded refusal carries the visitor's bucket, never the address (P2-16).
      ipSecret: widget.ipSecret,
    }),
  ];

  if (session) {
    guards.push(
      requireWidgetToken({
        loadKeys:
          widget.tokenKeys ?? (() => Promise.reject(new WidgetTokenKeysNotConfiguredError())),
        /*
         * A verifier that cannot ask has nothing to fail closed on, so an
         * absent check refuses every token rather than accepting one whose
         * revocation it could not read (P2-12a).
         */
        isRevoked: widget.isTokenRevoked ?? (() => Promise.resolve(true)),
        ...(widget.onTokenRejected === undefined ? {} : { onRejected: widget.onTokenRejected }),
        ipSecret: widget.ipSecret,
      }),
    );
  }

  guards.push(limitWidgetRequest({ limiter: widget.limiter, endpoint, ipSecret: widget.ipSecret }));

  app.on([...methods], [path], ...guards, handler);
};

export const createWidgetApp = (widget?: WidgetDependencies): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  /** See the note on the dashboard surface marker. */
  app.get('/', (c) => c.json({ surface: 'widget' as const }));

  if (widget === undefined) {
    app.on(['GET', 'OPTIONS'], CONFIG_PATH, () => {
      throw new WidgetNotConfiguredError();
    });
    app.on(['POST', 'OPTIONS'], SESSION_PATH, () => {
      throw new WidgetNotConfiguredError();
    });
    app.on(['POST', 'OPTIONS'], CHAT_PATH, () => {
      throw new WidgetNotConfiguredError();
    });

    return app;
  }

  /** The widget's public configuration (P2-10), behind the guards `mountGuarded` gives every route. */
  mountGuarded(
    app,
    widget,
    { methods: ['GET', 'OPTIONS'], path: CONFIG_PATH, endpoint: 'config' },
    async (c) => {
      const tenant = c.get('widgetTenant');
      const cap = planCapCheck(tenant.tenantId, tenant.plan);
      const used = await widget.readUsage(cap);

      c.header('Cache-Control', WIDGET_CONFIG_CACHE_CONTROL);

      return c.json(widgetConfigFor(tenant, quotaStateOf(used, cap.limit)));
    },
  );

  /**
   * Mints an origin-bound session token (P2-12, §3.2 layer 2).
   *
   * **Nothing in the body is read.** The tenant and its status come from the
   * guards, resolved uncached on this request (§5.7), and the origin is the one
   * CORS verified — so a caller cannot pick a tenant, a session id or an origin.
   * A previous token in `Authorization` may continue its session (P2-12a); the
   * session id then comes out of that token, once it is verified. The
   * server-to-server `sk_live_` path is P4-10's, which the row allows deferring.
   */
  mountGuarded(
    app,
    widget,
    { methods: ['POST', 'OPTIONS'], path: SESSION_PATH, endpoint: 'session' },
    async (c) => {
      const { tokenKeys } = widget;

      const session = await mintWidgetSession({
        loadKeys: tokenKeys ?? (() => Promise.reject(new WidgetTokenKeysNotConfiguredError())),
        tenant: c.get('widgetTenant'),
        origin: c.get('widgetOrigin'),
        previous: bearerTokenOf(c.req.header('authorization')),
        isRevoked: widget.isTokenRevoked,
      });

      c.header('Cache-Control', WIDGET_SESSION_CACHE_CONTROL);

      return c.json(session);
    },
  );

  /**
   * Answer one question, streamed (P2-29, §4.5).
   *
   * **The order is security, not style**, and `mountGuarded` holds it: the
   * address limit, CORS, the session token, then the tenant's limits. The quota
   * is checked inside the port, before retrieval and before generation, because
   * a check after either has already spent what it exists to save.
   *
   * **Nothing in the body is read but the message.** The tenant, the origin and
   * the session id all come from guards that established them (P0-48).
   *
   * **A refusal before the first event is a status; a failure after it is an
   * event.** Once the response has begun there is no status left to change, so
   * a provider error mid-stream arrives as `error` rather than truncating
   * silently — which a client cannot tell from a finished answer.
   */
  mountGuarded(
    app,
    widget,
    { methods: ['POST', 'OPTIONS'], path: CHAT_PATH, endpoint: 'chat', session: true },
    async (c) => {
      const { chat } = widget;

      if (chat === undefined) throw new WidgetNotConfiguredError();

      const parsed = chatRequest.safeParse(await readChatJson(c));

      if (!parsed.success) throw new InvalidRequestError(CHAT_BODY_EXPECTED);

      const tenant = c.get('widgetTenant');
      const answering = chat.answer(
        {
          tenant,
          sessionId: c.get('widgetSessionId'),
          origin: c.get('widgetOrigin'),
          visitorHash: visitorHashOf(c, widget.ipSecret),
          message: parsed.data.message,
          /* A visitor who closes the tab stops generation, and stops billing. */
          signal: c.req.raw.signal,
        },
        (report) => {
          logger.info({ ...report, tenantId: tenant.tenantId }, 'widget chat turn');
        },
      );

      const response = streamSSE(c, async (stream) => {
        const beat = setInterval(() => {
          /* A comment, not an event: it keeps intermediaries from dropping an
           * idle connection and means nothing to a client. */
          void stream.writeln(': keep-alive');
        }, HEARTBEAT_MS);

        try {
          for await (const chunk of answering) {
            await stream.writeSSE({ event: chunk.type, data: JSON.stringify(chunk) });
          }
        } catch (error) {
          /*
           * The response has already begun, so there is no status left to
           * change. The code is ours and says nothing a visitor could not be
           * told; the provider's own message never reaches here (P0-55).
           */
          await stream.writeSSE({
            event: 'error',
            data: JSON.stringify({
              code: error instanceof QuotaExceededError ? 'quota_exceeded' : 'provider_error',
            }),
          });
        } finally {
          clearInterval(beat);
          await stream.writeSSE({ event: 'done', data: '{}' });
        }
      });

      /*
       * **Set after, because `streamSSE` sets its own.** It writes
       * `Cache-Control: no-cache`, which drops `no-store` and — the one that
       * matters — `no-transform`. Without `no-transform` CloudFront may
       * compress the body, and compression is a buffering step: the stream
       * still arrives, all at once, and a buffered stream is indistinguishable
       * from a slow one.
       */
      for (const [header, value] of Object.entries(SSE_HEADERS))
        response.headers.set(header, value);

      return response;
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
      refusals: [],
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
      refusals: [403, 429],
    },
  ],
  [
    routeKey('POST', `${WIDGET_PREFIX}${CHAT_PATH}`),
    {
      access: publicRoute(
        'A visitor has no account, so there is no capability to hold. What gates it is the ' +
          '(pk_, Origin) pair, a verified session token bound to both, the per-address, ' +
          'per-session and per-endpoint limits, and the monthly plan cap - which is checked ' +
          'before retrieval and before any model call, because a check after either has ' +
          'already spent what it exists to save.',
      ),
      summary: 'Ask for a recommendation, streamed',
      description:
        'Answers one question against this shop catalogue and streams the reply as it is ' +
        'written. The response is text/event-stream: `text` events carry the reply in ' +
        'pieces, one `recommendations` event carries the wines to show, `error` carries a ' +
        'code if something failed after the stream began, and `done` is always last. A ' +
        'comment line arrives every fifteen seconds on an idle stream so intermediaries do ' +
        'not drop it. Only wines this request retrieved can be recommended: an id the model ' +
        'invents or borrows from another shop is dropped before the event is sent. Nothing ' +
        'in the body is read but the message - the tenant, the origin and the session all ' +
        'come from the key, the Origin and the token. Refused with 401 when the token is ' +
        'missing, expired, revoked or bound elsewhere; 403 when the key and Origin do not ' +
        'belong to one tenant; 429 when a limit or the month is spent. Never cached.',
      example: { type: 'text', delta: 'Con una bistecca le consiglio ' },
      response: widgetChatEvent,
      refusals: [401, 403, 422, 429],
    },
  ],
  [
    routeKey('POST', `${WIDGET_PREFIX}${SESSION_PATH}`),
    {
      access: publicRoute(
        'Called before a visitor has any identity, so it requires no token and no session; a ' +
          'previous token only continues one. What gates it is the (pk_, Origin) pair, the ' +
          'tenant being active or trialling - read uncached on every call - and the ' +
          'per-address, per-tenant and per-endpoint limits, because it is the cheapest ' +
          'endpoint on the surface to abuse.',
      ),
      summary: 'Mint a widget session token',
      description:
        'Mints a 15-minute EdDSA token bound to the request Origin, the tenant the public key ' +
        'belongs to, and a session id. Nothing in the body is read: the tenant, the session ' +
        'and the origin all come from the request itself. To continue a conversation, send ' +
        'its last token as `Authorization: Bearer <token>`: up to 30 minutes after that ' +
        "token expired, and 4 hours after the session's first token, the new token keeps " +
        'the session id. A token that cannot be verified, or is past either limit, starts a ' +
        'fresh session instead. Refused with 403 and no CORS headers unless the key and the ' +
        "Origin belong to one tenant; with 403 and code 'unavailable' when that tenant's " +
        'widget is switched off, which the widget renders as disabled; and with 401 when ' +
        'the token sent belongs to another site or tenant, or was revoked. Never cached.',
      example: { token: 'header.payload.signature', expiresAt: '2026-09-15T10:15:00.000Z' },
      response: widgetSessionResponse,
      refusals: [401, 403, 429],
    },
  ],
]);

/**
 * Access for the widget surface (P0-49): every documented route, and each
 * guarded route's CORS preflight.
 *
 * The preflight is declared and not documented. It is answered by the identical
 * resolution as the request it precedes, and a reference entry for it would be
 * describing the browser rather than the API.
 */
export const WIDGET_ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = new Map<string, RouteAccess>([
  ...[...WIDGET_ROUTES].map(([key, doc]): [string, RouteAccess] => [key, doc.access]),
  [
    routeKey('OPTIONS', `${WIDGET_PREFIX}${CHAT_PATH}`),
    publicRoute(
      'The CORS preflight for the chat route. Answered by the same (pk_, Origin) ' +
        'resolution as the message it precedes, with no body and no token.',
    ),
  ],
  [
    routeKey('OPTIONS', `${WIDGET_PREFIX}${CONFIG_PATH}`),
    publicRoute(
      'The CORS preflight for the config route. Answered by the same (pk_, Origin) ' +
        'resolution as the request it precedes, with no body and nothing else.',
    ),
  ],
  [
    routeKey('OPTIONS', `${WIDGET_PREFIX}${SESSION_PATH}`),
    publicRoute(
      'The CORS preflight for the session route. Answered by the same (pk_, Origin) ' +
        'resolution as the mint it precedes, with no body and no token.',
    ),
  ],
]);
