/// <reference path="../.sst/platform/config.d.ts" />

import { databaseUrl, parameterReadPermissions } from './config';
import {
  assertSweepFitsSchedule,
  SWEEP_DELETED_METRIC,
  SWEEP_METRIC_NAMESPACE,
  SWEEP_SCHEDULE,
  SWEEP_SILENCE_SECONDS,
  SWEEP_TIMEOUT_SECONDS,
} from './sweep-config';
import { vpc } from './vpc';

/**
 * The sweep (P2-14): lapsed token revocations and closed rate-limit windows,
 * deleted every fifteen minutes.
 *
 * Every number is in `sweep-config.ts`, which a test can import; this module
 * only builds resources from them.
 */

/** The timeout as the literal SST's type wants, asserted to agree with the figure the rules use. */
const SWEEP_TIMEOUT = '120 seconds' as const;

if (Number.parseInt(SWEEP_TIMEOUT, 10) !== SWEEP_TIMEOUT_SECONDS) {
  throw new Error(
    `The sweep's timeout literal (${SWEEP_TIMEOUT}) and SWEEP_TIMEOUT_SECONDS ` +
      `(${String(SWEEP_TIMEOUT_SECONDS)}) disagree (P2-14).`,
  );
}

assertSweepFitsSchedule();

/**
 * **`sst.aws.Cron`, for the poller's reason** (`queue.ts`): a bare rule has no
 * target and no invoke permission, so it fires and calls nothing while
 * CloudWatch shows it succeeding.
 *
 * In the VPC with the database URL and nothing else. It deletes rows and reads
 * no secret besides the connection string.
 */
export const sweep = new sst.aws.Cron('Sweep', {
  schedule: SWEEP_SCHEDULE,
  function: {
    handler: 'apps/worker/src/sweep.handler',
    architecture: 'arm64',
    runtime: 'nodejs22.x',
    memory: '256 MB',
    timeout: SWEEP_TIMEOUT,
    vpc,
    environment: {
      DATABASE_URL: databaseUrl.value,
      NODE_ENV: 'production',
      SST_STAGE: $app.stage,
    },
    permissions: [...parameterReadPermissions(['database/url'])],
  },
});

/**
 * A day with no row deleted.
 *
 * **Missing data is breaching**, the opposite of the DLQ alarm, and for the
 * opposite reason. An empty DLQ publishes nothing and is healthy; a sweep that
 * publishes nothing never ran. The metric comes out of the run's own log line
 * (Embedded Metric Format), so a run that fails before it logs counts as silent.
 */
new aws.cloudwatch.MetricAlarm('SweepDeletedNothing', {
  alarmDescription:
    'The sweep deleted no rows for a day, or never reported. Token revocations and rate-limit ' +
    'buckets only shrink when it runs, and both grow on every request (P2-14).',
  namespace: SWEEP_METRIC_NAMESPACE,
  metricName: SWEEP_DELETED_METRIC,
  dimensions: { Stage: $app.stage },
  statistic: 'Sum',
  period: SWEEP_SILENCE_SECONDS,
  evaluationPeriods: 1,
  threshold: 0,
  comparisonOperator: 'LessThanOrEqualToThreshold',
  treatMissingData: 'breaching',
});
