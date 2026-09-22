import type { FixedWindowCheck, LimitCheck, MonthlyCheck } from './types.js';

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
  /**
   * Per visitor address per minute, across every endpoint and every tenant,
   * counted **before** the key and origin are resolved (review fix).
   */
  readonly unresolvedPerMinute: number;
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
 * The launch numbers, sized for this product's ceiling of ten tenants (§5.0).
 *
 * **Decided 2026-09-15, and §3.6 gives the reason for each.** In short:
 * - The monthly caps are P5-01's plan allowances, 1,500 and 6,000 messages, and
 *   the trial's 150-message hard cap for a tenant with no subscription.
 * - Chat per session is one message every ten seconds: a reply takes three to
 *   eight, and nobody reads a recommendation faster than that.
 * - Chat per tenant is 60 a minute. At about five seconds a reply that is at
 *   most half the API's reserved concurrency of 10 (P1-48), so one winery cannot
 *   take the function from the other nine.
 * - Per address there is room for a few visitors behind one carrier NAT, and
 *   config reaches the API only on an edge cache miss (P2-10).
 * - The address-wide limit before resolution sits above one winery's
 *   per-address total, so a real visitor always meets that winery's limits first.
 *
 * The shape is what the tests hold — config gets the most room per address, a
 * paying tier outranks a trial — and changing a number is a plan edit too.
 */
export const WIDGET_LIMITS: WidgetLimits = {
  unresolvedPerMinute: 120,
  sessionPerMinute: { session: 6, chat: 6 },
  ipPerMinute: { config: 60, session: 10, chat: 20 },
  tenantPerMinute: { CANTINA: 60, ECOMMERCE: 120, none: 30 },
  endpointPerMinute: { config: 120, session: 60, chat: 60 },
  messagesPerMonth: { CANTINA: 1_500, ECOMMERCE: 6_000, none: 150 },
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

/**
 * The one check a widget request makes before anything is resolved (review fix).
 *
 * **Every other dimension needs the tenant, and the tenant costs a query.**
 * Resolving `(pk_, Origin)` is a read across three tables on every request,
 * uncached by design (§5.7), and CORS refuses an invented key only after that
 * read. Every limit came later still, so a script cycling through made-up keys
 * spent one query apiece with nothing to stop it. This bucket is the address
 * alone, across every tenant and endpoint, and it is counted first.
 *
 * Its own key, never a tenant's: `ip:<bucket>:unresolved` cannot collide with
 * `ip:<bucket>:<tenant>:<endpoint>`, which has four segments.
 */
export const unresolvedLimitCheck = (
  ipBucket: string,
  limits: WidgetLimits = WIDGET_LIMITS,
): FixedWindowCheck => ({
  key: `ip:${ipBucket}:unresolved`,
  limit: limits.unresolvedPerMinute,
  windowSec: MINUTE,
});

/** What marks the plan cap's key, so a caller can keep its numbers private. */
const PLAN_CAP_SUFFIX = ':month';

/**
 * A tenant's monthly plan cap, as a check.
 *
 * **One definition for spending the month and for reading it** (P2-10). Chat
 * spends it through `widgetLimitChecks`; the config route reads how much is left
 * with the same key and the same window. Two definitions would be two chances
 * to disagree, and the symptom of that is a widget told `ok` by one and refused
 * by the other.
 */
export const planCapCheck = (
  tenantId: string,
  plan: WidgetPlan | null,
  limits: WidgetLimits = WIDGET_LIMITS,
): MonthlyCheck => ({
  key: `tenant:${tenantId}${PLAN_CAP_SUFFIX}`,
  limit: limits.messagesPerMonth[plan ?? 'none'],
  window: 'month',
});

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
  if (endpoint === 'chat') checks.push(planCapCheck(tenantId, request.plan, limits));

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

/**
 * The tenant a plan-cap key names, or undefined for any other key.
 *
 * Here rather than at the call site for `isPlanCap`'s reason: the key's shape
 * is built above and read in two places, and a second copy of the parsing is a
 * second chance to disagree with the builder. P2-36 reads the month's usage for
 * the tenant a check names, and the check is all it is given.
 */
export const tenantOfPlanCap = (key: string): string | undefined =>
  isPlanCap(key) ? key.slice('tenant:'.length, -PLAN_CAP_SUFFIX.length) : undefined;

/** What a visitor's widget is told about the month (P2-10, §1.3). */
export type QuotaState = 'ok' | 'near' | 'exceeded';

/** From this share of the plan cap on, the widget is told `near`. */
export const QUOTA_NEAR_SHARE = 0.8;

/**
 * The month, coarsened.
 *
 * **An enum and never a number**, because `/v1/widget/config` is
 * world-readable and edge-cached: a remaining count would let a competitor read
 * a shop's traffic off its own widget (P2-10). Three states are what the widget
 * needs — carry on, warn the seller, show `QUOTA_EXCEEDED` — and nothing more.
 */
export const quotaStateOf = (used: number, limit: number): QuotaState => {
  if (used >= limit) return 'exceeded';
  return used >= limit * QUOTA_NEAR_SHARE ? 'near' : 'ok';
};
