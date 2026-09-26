/**
 * The WAF in front of CloudFront, as data (P4-13).
 *
 * **The blunt outer layer.** P2-04's limits are precise — per address, per
 * tenant, per endpoint, counted in Postgres — and they are the ones that decide.
 * The WAF exists to drop the traffic that should never reach the function at
 * all: known-bad inputs, addresses on Amazon's reputation list, and one address
 * sending far more than any real caller could.
 *
 * Pure, with no SST globals, so `infra/test/waf-rules.test.ts` holds the shape;
 * `waf.ts` turns it into the resource.
 */

/**
 * **Count first, block later — and this constant is the switch.**
 *
 * Managed rule sets are written for the average site, and a catalogue import
 * or a seller's backend is not average: going straight to block would break
 * legitimate traffic nobody saw in testing. Count records what *would* have
 * been blocked, in the sampled requests, for a week of review; then this
 * becomes `'block'`, in its own reviewed change.
 */
export const WAF_MODE: 'count' | 'block' = 'count';

/**
 * Bot Control is a paid rule group (a monthly fee plus a per-request charge),
 * and the row makes it conditional on the cost. Off until somebody decides the
 * cost is acceptable; the rule is written and tested either way.
 */
export const WAF_BOT_CONTROL = false;

/**
 * Per address, per five minutes: 600 a minute.
 *
 * **Well above every application limit it could meet first**, so a real caller
 * always hits P2-04's precise answer — a 429 with `Retry-After` — before this
 * blunt one. The widget's address-wide ceiling is 120 a minute; the dashboard's
 * auth limit is 100. Carrier NAT puts many visitors behind one address, which
 * is the other reason for the headroom.
 */
export const WAF_RATE_LIMIT_PER_5_MIN = 3000;
export const WAF_RATE_WINDOW_SEC = 300;

/**
 * Paths the rate rule never counts, because one address legitimately sends
 * more than it allows.
 *
 * - A seller's backend mints a server session per page view from one address
 *   (P4-10): up to 1,200 a minute by the application's own limit.
 * - Stripe and Resend deliver webhooks from a handful of addresses, in bursts,
 *   and each is signature-verified and idempotent before it costs anything.
 */
export const WAF_RATE_EXEMPT_PREFIXES: readonly string[] = [
  '/v1/widget/session/server',
  '/v1/webhooks/',
];

/**
 * Managed rules that stay at count even once the WAF blocks, with the reason.
 *
 * - `SizeRestrictions_BODY` refuses bodies over 8 KB; a catalogue import is up
 *   to 5 MB (P1-11), and a webhook payload routinely exceeds 8 KB.
 * - `NoUserAgent_HEADER` refuses requests with no `User-Agent`, which a
 *   seller's server calling the session mint (P4-10) may well not send.
 */
export const WAF_PERMANENT_COUNT_RULES: readonly {
  readonly group: string;
  readonly rule: string;
}[] = [
  { group: 'AWSManagedRulesCommonRuleSet', rule: 'SizeRestrictions_BODY' },
  { group: 'AWSManagedRulesCommonRuleSet', rule: 'NoUserAgent_HEADER' },
];

const visibility = (metricName: string) => ({
  cloudwatchMetricsEnabled: true,
  metricName,
  /* What the week of review reads: the requests a rule matched, with their headers. */
  sampledRequestsEnabled: true,
});

const managedGroup = (name: string, priority: number, mode: 'count' | 'block') => ({
  name,
  priority,
  /*
   * `count` overrides every rule in the group to count; `none` leaves each
   * rule's own action (block) in place.
   */
  overrideAction: mode === 'count' ? { count: {} } : { none: {} },
  statement: {
    managedRuleGroupStatement: {
      vendorName: 'AWS',
      name,
      ruleActionOverrides: WAF_PERMANENT_COUNT_RULES.filter((entry) => entry.group === name).map(
        (entry) => ({ name: entry.rule, actionToUse: { count: {} } }),
      ),
    },
  },
  visibilityConfig: visibility(name),
});

const startsWith = (prefix: string) => ({
  byteMatchStatement: {
    searchString: prefix,
    positionalConstraint: 'STARTS_WITH',
    fieldToMatch: { uriPath: {} },
    textTransformations: [{ priority: 0, type: 'NONE' }],
  },
});

/**
 * The rules, in evaluation order. Reputation first: an address Amazon already
 * knows is bad is dropped before anything inspects its body.
 */
export const wafRules = (mode: 'count' | 'block' = WAF_MODE, botControl = WAF_BOT_CONTROL) => [
  managedGroup('AWSManagedRulesAmazonIpReputationList', 0, mode),
  managedGroup('AWSManagedRulesKnownBadInputsRuleSet', 1, mode),
  managedGroup('AWSManagedRulesCommonRuleSet', 2, mode),
  ...(botControl ? [managedGroup('AWSManagedRulesBotControlRuleSet', 3, mode)] : []),
  {
    name: 'RatePerAddress',
    priority: 10,
    action: mode === 'count' ? { count: {} } : { block: {} },
    statement: {
      rateBasedStatement: {
        limit: WAF_RATE_LIMIT_PER_5_MIN,
        evaluationWindowSec: WAF_RATE_WINDOW_SEC,
        aggregateKeyType: 'IP',
        scopeDownStatement: {
          notStatement: {
            statements: [
              {
                orStatement: { statements: WAF_RATE_EXEMPT_PREFIXES.map(startsWith) },
              },
            ],
          },
        },
      },
    },
    visibilityConfig: visibility('RatePerAddress'),
  },
];

/**
 * The web ACL. `CLOUDFRONT` scope, which AWS only accepts in `us-east-1` —
 * `waf.ts` creates it through a provider pinned there.
 *
 * **No response is buffered by any of this.** WAF inspects requests, and at
 * most the first part of a body; it never holds a response, so the streaming
 * chat path (P2-29) needs no exclusion from it.
 */
export const wafAclArgs = (mode: 'count' | 'block' = WAF_MODE, botControl = WAF_BOT_CONTROL) => ({
  description: `Edge filter in front of the API and dashboard (P4-13), in ${mode} mode`,
  scope: 'CLOUDFRONT',
  defaultAction: { allow: {} },
  rules: wafRules(mode, botControl),
  visibilityConfig: visibility('SommelierEdge'),
});
