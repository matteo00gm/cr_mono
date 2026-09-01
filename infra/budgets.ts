/// <reference path="../.sst/platform/config.d.ts" />

import { isProtectedStage } from './stage';

/**
 * Cost alarms (P0-16).
 *
 * §5.8 sets a target of under $15/month for non-prod. An unmonitored target is
 * a wish — and the specific thing being guarded against is a misconfigured NAT
 * Gateway, which costs ~$32/month per AZ and produces no other symptom.
 */

/**
 * §5.2a estimates ~$25/month for production. The alarm sits above that, not on
 * it: a threshold set at the estimate fires on ordinary variance, and an alarm
 * that cries wolf is muted within a month.
 */
const PROD_BUDGET_USD = 35;

/**
 * §5.8's $15 is the target for **all non-prod combined**, but AWS Budgets are
 * created per stage here, so N non-prod stages can total N x $15 without any
 * alarm firing. See the open items in Part 11 — the fix is an account-level
 * budget created once outside per-stage IaC, which no stage's stack can own.
 */
const NON_PROD_BUDGET_USD = 15;

const isProd = isProtectedStage($app.stage);
const limit = isProd ? PROD_BUDGET_USD : NON_PROD_BUDGET_USD;

/**
 * Where alarms go. A secret rather than a literal, so no personal address is
 * committed; set it with `sst secret set BudgetAlertEmail you@example.com`.
 */
const alertEmail = new sst.Secret('BudgetAlertEmail');

const topic = new aws.sns.Topic('BudgetAlerts', {
  displayName: `sommelier-${$app.stage}-budget`,
});

new aws.sns.TopicSubscription('BudgetAlertsEmail', {
  topic: topic.arn,
  protocol: 'email',
  endpoint: alertEmail.value,
});

new aws.budgets.Budget('MonthlyCost', {
  budgetType: 'COST',
  timeUnit: 'MONTHLY',
  limitAmount: String(limit),
  limitUnit: 'USD',

  // Scoped by the `env` tag that P0-11 applies to every resource via
  // `defaultTags`. Without those tags this filter matches nothing and the
  // budget silently watches an empty set — which is why the tags had to land
  // in the first infra commit rather than later.
  costFilters: [
    {
      name: 'TagKeyValue',
      values: [`user:env$${$app.stage}`],
    },
  ],

  notifications: [
    {
      // Forecast first. It fires before the money is spent, which is the only
      // kind of cost alert you can still act on.
      comparisonOperator: 'GREATER_THAN',
      threshold: 100,
      thresholdType: 'PERCENTAGE',
      notificationType: 'FORECASTED',
      subscriberSnsTopicArns: [topic.arn],
    },
    {
      comparisonOperator: 'GREATER_THAN',
      threshold: 80,
      thresholdType: 'PERCENTAGE',
      notificationType: 'ACTUAL',
      subscriberSnsTopicArns: [topic.arn],
    },
  ],
});
