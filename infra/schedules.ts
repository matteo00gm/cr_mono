/// <reference path="../.sst/platform/config.d.ts" />

import { authBaseUrl, emailAllowlist, emailFrom, resendApiKey } from './api';
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

/**
 * The claim sweep (P4-18b): sends each domain-claim notice, settles each notice
 * that was sent and has run out, and tells both wineries how a claim ended.
 *
 * Every five minutes: a notice's 72 hours start when its mail is stamped as
 * sent, so this cadence is the most a holder's notice can start late — and the
 * most a claimant waits past the deadline.
 *
 * In the VPC for the database, and with the same mail configuration the API
 * has, because it is the second thing in this system that sends mail. Outside
 * production that configuration logs every message unless its address is on
 * the allowlist, exactly as the API's does.
 */
export const claimSweep = new sst.aws.Cron('ClaimSweep', {
  schedule: 'rate(5 minutes)',
  function: {
    handler: 'apps/worker/src/claims.handler',
    architecture: 'arm64',
    runtime: 'nodejs22.x',
    memory: '256 MB',
    timeout: '120 seconds',
    vpc,
    environment: {
      DATABASE_URL: databaseUrl.value,
      NODE_ENV: 'production',
      SST_STAGE: $app.stage,
      AUTH_BASE_URL: authBaseUrl.value,
      EMAIL_FROM: emailFrom.value,
      RESEND_API_KEY: resendApiKey.value,
      EMAIL_ALLOWLIST: emailAllowlist.value,
    },
    permissions: [...parameterReadPermissions(['database/url'])],
  },
});
