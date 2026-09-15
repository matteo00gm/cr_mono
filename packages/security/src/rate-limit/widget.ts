import type { LimitCheck } from './types.js';

/**
 * The widget's limit dimensions (P2-04, §3.6).
 *
 * Pure: which buckets a request draws from, and how large each one is. The
 * middleware in `apps/api` supplies the request and applies the answer, and a
 * limiter behind the P2-01 interface does the counting — so the policy can be
 * read, tested and changed here with no database and no HTTP in sight.
 *
 * **No Node built-ins here, deliberately.** This package is imported by the
 * dashboard's browser bundle, so the address HMAC, which needs `node:crypto`,
 * lives beside the middleware in `apps/api` instead.
 *
 * **Every dimension goes into one `check` call, all-or-nothing** (P2-01). A
 * visitor refused by their address bucket costs the tenant's minute and month
 * nothing, which is what stops one scripted client spending a winery's plan on
 * everybody else's behalf.
 */

export type WidgetEndpoint = 'config' | 'session' | 'chat';

/** The launch plans (P5-01). */
export type WidgetPlan = 'CANTINA' | 'ECOMMERCE';

/** A plan, or `none` for a tenant with no subscription yet. */
export type PlanTier = WidgetPlan | 'none';

export interface WidgetLimits {
  /** Per visitor session, per endpoint, per minute. `config` carries no session. */
  readonly sessionPerMinute: Readonly<Record<Exclude<WidgetEndpoint, 'config'>, number>>;
  /** Per visitor address, per tenant, per endpoint, per minute. */
  readonly ipPerMinute: Readonly<Record<WidgetEndpoint, number>>;
  /** Per tenant across every endpoint, per minute — protects our infrastructure. */
  readonly tenantPerMinute: Readonly<Record<PlanTier, number>>;
  /** Per tenant, per endpoint, per minute — chat is expensive and config is not. */
  readonly endpointPerMinute: Readonly<Record<WidgetEndpoint, number>>;
  /** Chat messages per tenant per UTC calendar month — the billing boundary. */
  readonly messagesPerMonth: Readonly<Record<PlanTier, number>>;
}

/**
 * The launch numbers.
 *
 * **Provisional, and recorded as open in the plan.** §3.6 names the dimensions
 * and gives no figures, and the monthly caps are really decided by P5-01's
 * pricing. What these do fix is the shape: config, fetched on every page view,
 * gets the most room; a session mint is the rarest thing a visitor needs; and a
 * paying tier outranks a tenant with no subscription.
 */
export const WIDGET_LIMITS: WidgetLimits = {
  sessionPerMinute: { session: 6, chat: 12 },
  ipPerMinute: { config: 60, session: 12, chat: 30 },
  tenantPerMinute: { CANTINA: 120, ECOMMERCE: 600, none: 60 },
  endpointPerMinute: { config: 600, session: 120, chat: 120 },
  messagesPerMonth: { CANTINA: 1_000, ECOMMERCE: 10_000, none: 100 },
};

export interface WidgetRequest {
  readonly endpoint: WidgetEndpoint;
  /** Resolved from `(pk_, Origin)` (P2-07), never read from the request. */
  readonly tenantId: string;
  readonly plan: WidgetPlan | null;
  /** An HMAC of the visitor's address, never the address itself. */
  readonly ipBucket: string;
  /** Present once a session token has been verified (P2-13). */
  readonly sessionId?: string | undefined;
}

const MINUTE = 60;

/** What marks the plan cap's key, so a caller can keep its numbers private. */
const PLAN_CAP_SUFFIX = ':month';

/**
 * The checks one widget request makes.
 *
 * **Keys carry the endpoint wherever the limit differs by endpoint.** §3.6
 * writes `session:<sid>` and `ip:<hash>:<tenant>`, but one bucket counted
 * against two different limits refuses at whichever limit the latest caller
 * passed — so a burst of chat could lock a visitor out of minting a session.
 */
export const widgetLimitChecks = (
  request: WidgetRequest,
  limits: WidgetLimits = WIDGET_LIMITS,
): LimitCheck[] => {
  const { endpoint, tenantId } = request;
  const tier: PlanTier = request.plan ?? 'none';
  const checks: LimitCheck[] = [];

  if (request.sessionId !== undefined && endpoint !== 'config') {
    checks.push({
      key: `session:${request.sessionId}:${endpoint}`,
      limit: limits.sessionPerMinute[endpoint],
      windowSec: MINUTE,
    });
  }

  checks.push(
    {
      key: `ip:${request.ipBucket}:${tenantId}:${endpoint}`,
      limit: limits.ipPerMinute[endpoint],
      windowSec: MINUTE,
    },
    { key: `tenant:${tenantId}:min`, limit: limits.tenantPerMinute[tier], windowSec: MINUTE },
    {
      key: `endpoint:${endpoint}:${tenantId}`,
      limit: limits.endpointPerMinute[endpoint],
      windowSec: MINUTE,
    },
  );

  /*
   * Only chat counts against the month. A message is what a plan sells, and
   * counting config would spend a winery's allowance on every page view by a
   * visitor who never opened the widget.
   */
  if (endpoint === 'chat') {
    checks.push({
      key: `tenant:${tenantId}${PLAN_CAP_SUFFIX}`,
      limit: limits.messagesPerMonth[tier],
      window: 'month',
    });
  }

  return checks;
};

/**
 * True for the monthly plan cap's key.
 *
 * A refusal on that dimension must not publish its numbers: an
 * `X-RateLimit-Limit` of 1000 tells anyone which plan a winery pays for, and
 * §1.3 says a visitor is never shown plan or billing details.
 */
export const isPlanCap = (key: string): boolean =>
  key.startsWith('tenant:') && key.endsWith(PLAN_CAP_SUFFIX);
