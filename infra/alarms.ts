/// <reference path="../.sst/platform/config.d.ts" />

import {
  CHAT_P95_MS,
  CHAT_P95_PERIOD_SECONDS,
  CHAT_P95_PERIODS,
  DATABASE_CPU_PERCENT,
  DATABASE_PERIOD_SECONDS,
  DATABASE_PERIODS,
  databaseConnectionsThreshold,
  ERROR_RATE_PERIOD_SECONDS,
  ERROR_RATE_THRESHOLD,
  errorRateExpression,
  QUEUE_AGE_PERIOD_SECONDS,
  QUEUE_AGE_PERIODS,
  QUEUE_AGE_SECONDS,
  QUOTA_REFUSALS_METRIC,
  QUOTA_REFUSALS_PERIOD_SECONDS,
  QUOTA_REFUSALS_THRESHOLD,
  REFUSED_ORIGINS_METRIC,
  REFUSED_ORIGINS_PERIOD_SECONDS,
  REFUSED_ORIGINS_THRESHOLD,
  SCHEDULED_ERRORS_PERIOD_SECONDS,
  sumExpression,
  TENANT_COST_METRIC,
  TENANT_COST_PERIOD_SECONDS,
  TENANT_DAILY_COST_MICROS,
  WIDGET_METRIC_NAMESPACE,
} from './alarm-config';
import { notify } from './alerting';
import { api, chat } from './api';
import { database } from './database';
import { embeddingQueue, outboxPoller } from './queue';
import { ROLLUP_METRIC_NAMESPACE } from './rollup-config';
import { claimSweep, sweep, usageRollup } from './schedules';

/**
 * The alarms that watch more than one thing, or something no other file owns
 * (P7-02). An alarm about one resource lives beside it — the DLQ's in
 * `queue.ts`, the sweep's in `schedules.ts` — and all of them are routed the
 * same way, through `notify`.
 *
 * **Every one has an entry in `docs/runbooks/alarms.md`**, and
 * `test/alarm-config.test.ts` fails for one that does not: an alarm without a
 * response is noise that teaches people to ignore alarms.
 *
 * None of these can be unit-tested for firing. The names, the thresholds, the
 * expressions and the runbook are; that each fires is a thing to force once in
 * a review stage, and the runbook says how.
 */

/* ------------------------------------------------------------ errors */

/**
 * The share of requests a function answered with a 5xx, from the Function
 * URL's own metrics: counted by AWS, so a container that died before logging
 * anything is still in it.
 */
const errorRateAlarm = (
  name: 'Api5xxRate' | 'Chat5xxRate',
  fn: typeof api,
  what: string,
): aws.cloudwatch.MetricAlarm =>
  new aws.cloudwatch.MetricAlarm(name, {
    alarmDescription:
      `More than a twentieth of ${what} requests are failing with a 5xx. Read the function's ` +
      'error logs by request id; a deploy in the last hour is the first suspect.',
    comparisonOperator: 'GreaterThanThreshold',
    evaluationPeriods: 1,
    threshold: ERROR_RATE_THRESHOLD,
    /* Below the floor the expression returns nothing, and quiet is not broken. */
    treatMissingData: 'notBreaching',
    metricQueries: [
      { id: 'rate', expression: errorRateExpression(), label: '5xx rate', returnData: true },
      {
        id: 'r',
        metric: {
          namespace: 'AWS/Lambda',
          metricName: 'UrlRequestCount',
          dimensions: { FunctionName: fn.name },
          stat: 'Sum',
          period: ERROR_RATE_PERIOD_SECONDS,
        },
      },
      {
        id: 'e',
        metric: {
          namespace: 'AWS/Lambda',
          metricName: 'Url5xxCount',
          dimensions: { FunctionName: fn.name },
          stat: 'Sum',
          period: ERROR_RATE_PERIOD_SECONDS,
        },
      },
    ],
    ...notify,
  });

errorRateAlarm('Api5xxRate', api, 'API');
errorRateAlarm('Chat5xxRate', chat, 'chat');

/* ------------------------------------------------------------ the chat function */

/**
 * The chat function's own cap, on `ApiThrottles`' terms (P1-48): a throttle is
 * a visitor's question refused before any code ran, with no log line of ours.
 */
new aws.cloudwatch.MetricAlarm('ChatThrottles', {
  alarmDescription:
    'The chat function is at its reserved concurrency and refusing visitors. It shares the ' +
    'database with the API: raise the instance class and the caps together, never one alone.',
  namespace: 'AWS/Lambda',
  metricName: 'Throttles',
  dimensions: { FunctionName: chat.name },
  statistic: 'Sum',
  period: 300,
  evaluationPeriods: 1,
  threshold: 0,
  comparisonOperator: 'GreaterThanThreshold',
  treatMissingData: 'notBreaching',
  ...notify,
});

new aws.cloudwatch.MetricAlarm('ChatLatencyP95', {
  alarmDescription:
    'One chat turn in twenty is taking over twenty seconds, for a quarter of an hour. The ' +
    'model provider is slow or retrieval is; a trace of a slow turn says which (P7-01).',
  namespace: 'AWS/Lambda',
  metricName: 'Duration',
  dimensions: { FunctionName: chat.name },
  extendedStatistic: 'p95',
  period: CHAT_P95_PERIOD_SECONDS,
  evaluationPeriods: CHAT_P95_PERIODS,
  threshold: CHAT_P95_MS,
  comparisonOperator: 'GreaterThanThreshold',
  /* No turns is no latency: an empty night must not page anybody. */
  treatMissingData: 'notBreaching',
  ...notify,
});

/* ------------------------------------------------------------ the widget's guards */

new aws.cloudwatch.MetricAlarm('RefusedOriginSpike', {
  alarmDescription:
    'A run of widget requests from sites their winery has not verified. A copied snippet, or ' +
    'a seller who moved their shop: the dashboard panel of refused sites says which (P6-05).',
  namespace: WIDGET_METRIC_NAMESPACE,
  metricName: REFUSED_ORIGINS_METRIC,
  dimensions: { Stage: $app.stage },
  statistic: 'Sum',
  period: REFUSED_ORIGINS_PERIOD_SECONDS,
  evaluationPeriods: 1,
  threshold: REFUSED_ORIGINS_THRESHOLD,
  comparisonOperator: 'GreaterThanThreshold',
  treatMissingData: 'notBreaching',
  ...notify,
});

new aws.cloudwatch.MetricAlarm('QuotaRefusalSpike', {
  alarmDescription:
    'Shoppers are being turned away because a winery has spent its month. It has had the 100% ' +
    'email (P5-12); find which winery in usage_daily and offer a top-up or the next plan.',
  namespace: WIDGET_METRIC_NAMESPACE,
  metricName: QUOTA_REFUSALS_METRIC,
  dimensions: { Stage: $app.stage },
  statistic: 'Sum',
  period: QUOTA_REFUSALS_PERIOD_SECONDS,
  evaluationPeriods: 1,
  threshold: QUOTA_REFUSALS_THRESHOLD,
  comparisonOperator: 'GreaterThanThreshold',
  treatMissingData: 'notBreaching',
  ...notify,
});

/* ------------------------------------------------------------ the queue */

new aws.cloudwatch.MetricAlarm('EmbeddingQueueAge', {
  alarmDescription:
    'The oldest wine waiting to be indexed has waited a quarter of an hour. The worker is not ' +
    'draining the queue: throttled by the provider, failing and retrying, or not running.',
  namespace: 'AWS/SQS',
  metricName: 'ApproximateAgeOfOldestMessage',
  dimensions: { QueueName: embeddingQueue.nodes.queue.name },
  statistic: 'Maximum',
  period: QUEUE_AGE_PERIOD_SECONDS,
  evaluationPeriods: QUEUE_AGE_PERIODS,
  threshold: QUEUE_AGE_SECONDS,
  comparisonOperator: 'GreaterThanThreshold',
  /* An empty queue has no oldest message. */
  treatMissingData: 'notBreaching',
  ...notify,
});

/* ------------------------------------------------------------ the bill */

new aws.cloudwatch.MetricAlarm('TenantModelSpend', {
  alarmDescription:
    'One winery cost more than a dollar in model calls in a day, which no plan sells. A loop, ' +
    'a wrong price, or the stronger tier answering everything: usage_daily says which winery.',
  namespace: ROLLUP_METRIC_NAMESPACE,
  metricName: TENANT_COST_METRIC,
  dimensions: { Stage: $app.stage },
  statistic: 'Maximum',
  period: TENANT_COST_PERIOD_SECONDS,
  evaluationPeriods: 1,
  threshold: TENANT_DAILY_COST_MICROS,
  comparisonOperator: 'GreaterThanThreshold',
  /* A night with no rollup is `UsageRollupSilent`'s to report, not this one's. */
  treatMissingData: 'notBreaching',
  ...notify,
});

/* ------------------------------------------------------------ the database */

/*
 * Only where there is an instance to watch. Under `sst dev` the component can
 * stand in a local Postgres for the RDS one, and then there is no instance, no
 * metric, and nothing an alarm could say.
 */
const { instance } = database.nodes;

if (instance !== undefined) {
  const dimensions = { DBInstanceIdentifier: instance.identifier };

  new aws.cloudwatch.MetricAlarm('DatabaseCpu', {
    alarmDescription:
      'The database has been above four fifths CPU for a quarter of an hour. Look for the ' +
      'query in Performance Insights before raising the instance class.',
    namespace: 'AWS/RDS',
    metricName: 'CPUUtilization',
    dimensions,
    statistic: 'Average',
    period: DATABASE_PERIOD_SECONDS,
    evaluationPeriods: DATABASE_PERIODS,
    threshold: DATABASE_CPU_PERCENT,
    comparisonOperator: 'GreaterThanThreshold',
    /* The instance always reports. Silence is the database not being there. */
    treatMissingData: 'breaching',
    ...notify,
  });

  new aws.cloudwatch.MetricAlarm('DatabaseConnections', {
    alarmDescription:
      'Four fifths of the connections the instance accepts are in use. The API and the worker ' +
      'are budgeted half; something else is holding the rest, and a request is refused next.',
    namespace: 'AWS/RDS',
    metricName: 'DatabaseConnections',
    dimensions,
    statistic: 'Maximum',
    period: DATABASE_PERIOD_SECONDS,
    evaluationPeriods: DATABASE_PERIODS,
    threshold: databaseConnectionsThreshold(),
    comparisonOperator: 'GreaterThanThreshold',
    treatMissingData: 'breaching',
    ...notify,
  });
}

/* ------------------------------------------------------------ the scheduled jobs */

/**
 * Any scheduled run that threw. One alarm for the four, because the response
 * is the same — read the job's own log — and four alarms would be four emails
 * the night the database is down.
 *
 * Beside `SweepDeletedNothing` and `UsageRollupSilent`, not instead of them:
 * those catch a job that did not run or did nothing, this catches one that ran
 * and failed. The claim sweep and the poller have no silence alarm, so for
 * them this is the only one.
 */
const scheduled = [sweep, claimSweep, usageRollup, outboxPoller];

new aws.cloudwatch.MetricAlarm('ScheduledJobErrors', {
  alarmDescription:
    'A scheduled job failed: the sweep, the claim sweep, the usage rollup or the outbox ' +
    'poller. Each logs its own failure; the Errors metric per function says which.',
  comparisonOperator: 'GreaterThanThreshold',
  evaluationPeriods: 1,
  threshold: 0,
  treatMissingData: 'notBreaching',
  metricQueries: [
    {
      id: 'failed',
      expression: sumExpression(scheduled.length),
      label: 'Failed scheduled runs',
      returnData: true,
    },
    ...scheduled.map((job, index) => ({
      id: `e${String(index)}`,
      metric: {
        namespace: 'AWS/Lambda',
        metricName: 'Errors',
        dimensions: { FunctionName: job.nodes.function.name },
        stat: 'Sum',
        period: SCHEDULED_ERRORS_PERIOD_SECONDS,
      },
    })),
  ],
  ...notify,
});
