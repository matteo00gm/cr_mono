import { describe, expect, it } from 'vitest';

import { SERVER_SESSION_ADDRESS_PER_MINUTE } from '../../apps/api/src/middleware/rate-limit';
import { WIDGET_LIMITS } from '../../packages/security/src/rate-limit/widget';
import {
  WAF_BOT_CONTROL,
  WAF_MODE,
  WAF_PERMANENT_COUNT_RULES,
  WAF_RATE_EXEMPT_PREFIXES,
  WAF_RATE_LIMIT_PER_5_MIN,
  WAF_RATE_WINDOW_SEC,
  wafAclArgs,
  wafRules,
} from '../waf-rules';

/**
 * The WAF, as data (P4-13).
 *
 * The row calls the WAF itself not unit-testable, and the behaviour at the edge
 * is not — it is verified with a probe against a deployed stage. What *is*
 * testable is everything that decides what the probe will find: the mode, the
 * rule set, and the relation between the WAF's rate and the application's own
 * limits, which is read from the application rather than restated.
 */

type Rule = ReturnType<typeof wafRules>[number];

const named = (rules: readonly Rule[], name: string): Rule | undefined =>
  rules.find((rule) => rule.name === name);

describe('the mode', () => {
  it('ships in count, so a managed rule cannot break real traffic unseen', () => {
    expect(WAF_MODE).toBe('count');
    expect(wafAclArgs().description).toContain('count mode');
  });

  it('counts, and blocks nothing, in count mode', () => {
    for (const rule of wafRules('count', true)) {
      if ('overrideAction' in rule) expect(rule.overrideAction).toEqual({ count: {} });
      if ('action' in rule) expect(rule.action).toEqual({ count: {} });
    }
  });

  it('blocks with every rule in block mode', () => {
    for (const rule of wafRules('block', true)) {
      if ('overrideAction' in rule) expect(rule.overrideAction).toEqual({ none: {} });
      if ('action' in rule) expect(rule.action).toEqual({ block: {} });
    }
  });

  it('lets everything the rules do not match through', () => {
    expect(wafAclArgs().defaultAction).toEqual({ allow: {} });
    expect(wafAclArgs().scope).toBe('CLOUDFRONT');
  });
});

describe('the managed rules', () => {
  it('are the three the row names, reputation first', () => {
    expect(
      wafRules()
        .filter((rule) => 'overrideAction' in rule)
        .map((rule) => rule.name),
    ).toEqual([
      'AWSManagedRulesAmazonIpReputationList',
      'AWSManagedRulesKnownBadInputsRuleSet',
      'AWSManagedRulesCommonRuleSet',
    ]);
  });

  it('leave bot control out until its cost is agreed, and add it when it is', () => {
    expect(WAF_BOT_CONTROL).toBe(false);
    expect(named(wafRules('count', true), 'AWSManagedRulesBotControlRuleSet')).toBeDefined();
  });

  it('keep the body-size rule at count forever, because an import is up to 5 MB', () => {
    const common = named(wafRules('block'), 'AWSManagedRulesCommonRuleSet');
    const overrides =
      common && 'overrideAction' in common
        ? common.statement.managedRuleGroupStatement.ruleActionOverrides
        : [];

    expect(overrides).toEqual(
      WAF_PERMANENT_COUNT_RULES.map((entry) => ({ name: entry.rule, actionToUse: { count: {} } })),
    );
    expect(overrides.map((override) => override.name)).toContain('SizeRestrictions_BODY');
    expect(overrides.map((override) => override.name)).toContain('NoUserAgent_HEADER');
  });

  it('give every rule a distinct priority, since WAF refuses a tie', () => {
    const priorities = wafRules('count', true).map((rule) => rule.priority);

    expect(new Set(priorities).size).toBe(priorities.length);
  });

  it('record samples for every rule, which is what the week of review reads', () => {
    for (const rule of wafRules('count', true)) {
      expect(rule.visibilityConfig.sampledRequestsEnabled, rule.name).toBe(true);
    }
  });
});

describe('the rate rule', () => {
  const perMinute = (WAF_RATE_LIMIT_PER_5_MIN * 60) / WAF_RATE_WINDOW_SEC;

  it("sits well above the application's own address limits, so those answer first", () => {
    /*
     * P2-04 answers with a 429 and a `Retry-After` a client can act on; the
     * WAF answers with a bare 403. A real caller must always meet the first.
     */
    expect(perMinute).toBeGreaterThanOrEqual(4 * WIDGET_LIMITS.unresolvedPerMinute);
  });

  it('never counts the server mint, whose one address may exceed it by design', () => {
    /* The reason the exemption exists: the application allows this much. */
    expect(SERVER_SESSION_ADDRESS_PER_MINUTE).toBeGreaterThan(perMinute);
    expect(WAF_RATE_EXEMPT_PREFIXES).toContain('/v1/widget/session/server');
  });

  it('never counts webhooks, which arrive in bursts from a few addresses', () => {
    expect(WAF_RATE_EXEMPT_PREFIXES).toContain('/v1/webhooks/');
  });

  it('scopes itself to everything but the exempt paths', () => {
    const rule = named(wafRules(), 'RatePerAddress');
    const scope =
      rule && 'action' in rule ? rule.statement.rateBasedStatement.scopeDownStatement : undefined;
    const exempt = scope?.notStatement.statements[0]?.orStatement.statements.map(
      (statement) => statement.byteMatchStatement,
    );

    expect(exempt?.map((match) => match.searchString)).toEqual([...WAF_RATE_EXEMPT_PREFIXES]);
    for (const match of exempt ?? []) {
      expect(match.positionalConstraint).toBe('STARTS_WITH');
      expect(match.fieldToMatch).toEqual({ uriPath: {} });
    }
  });

  it('counts per address, over five minutes', () => {
    const rule = named(wafRules(), 'RatePerAddress');
    const statement = rule && 'action' in rule ? rule.statement.rateBasedStatement : undefined;

    expect(statement?.aggregateKeyType).toBe('IP');
    expect(statement?.evaluationWindowSec).toBe(300);
  });
});
