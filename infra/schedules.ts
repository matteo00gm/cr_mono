/// <reference path="../.sst/platform/config.d.ts" />

import { notify } from './alerting';
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
import {
  ROLLUP_METRIC_NAMESPACE,
  ROLLUP_RUNS_METRIC,
  ROLLUP_SCHEDULE,
  ROLLUP_SILENCE_SECONDS,
  ROLLUP_TIMEOUT_SECONDS,
} from './rollup-config';
import {
  RETENTION_METRIC_NAMESPACE,
  RETENTION_RUNS_METRIC,
  RETENTION_SCHEDULE,
  RETENTION_SILENCE_SECONDS,
  RETENTION_TIMEOUT_SECONDS,
} from './retention-config';
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
  ...notify,
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

/** The rollup's timeout as the literal SST's type wants, asserted to agree with its config. */
const ROLLUP_TIMEOUT = '300 seconds' as const;

if (Number.parseInt(ROLLUP_TIMEOUT, 10) !== ROLLUP_TIMEOUT_SECONDS) {
  throw new Error(
    `The rollup's timeout literal (${ROLLUP_TIMEOUT}) and ROLLUP_TIMEOUT_SECONDS ` +
      `(${String(ROLLUP_TIMEOUT_SECONDS)}) disagree (P5-13).`,
  );
}

/**
 * The nightly rollup (P5-13): every tenant's last two days, recomputed into
 * `usage_daily`. In the VPC with the database URL and nothing else — it reads
 * the ledger and writes the rollup, and needs no secret besides the connection.
 */
export const usageRollup = new sst.aws.Cron('UsageRollup', {
  schedule: ROLLUP_SCHEDULE,
  function: {
    handler: 'apps/worker/src/rollup.handler',
    architecture: 'arm64',
    runtime: 'nodejs22.x',
    memory: '256 MB',
    timeout: ROLLUP_TIMEOUT,
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
 * A night with no run reported. **Missing data is breaching**, for the sweep's
 * reason: a run that never logs is a run that never ran, and the history
 * charts would quietly stop at the last night that did.
 */
new aws.cloudwatch.MetricAlarm('UsageRollupSilent', {
  alarmDescription:
    'The nightly usage rollup reported no run for a day. usage_daily stops at the last night ' +
    'that ran, and the dashboard history with it (P5-13).',
  namespace: ROLLUP_METRIC_NAMESPACE,
  metricName: ROLLUP_RUNS_METRIC,
  dimensions: { Stage: $app.stage },
  statistic: 'Sum',
  period: ROLLUP_SILENCE_SECONDS,
  evaluationPeriods: 1,
  threshold: 1,
  comparisonOperator: 'LessThanThreshold',
  treatMissingData: 'breaching',
  ...notify,
});

/** The purge's timeout as the literal SST's type wants, asserted to agree with its config. */
const RETENTION_TIMEOUT = '300 seconds' as const;

if (Number.parseInt(RETENTION_TIMEOUT, 10) !== RETENTION_TIMEOUT_SECONDS) {
  throw new Error(
    `The retention purge's timeout literal (${RETENTION_TIMEOUT}) and RETENTION_TIMEOUT_SECONDS ` +
      `(${String(RETENTION_TIMEOUT_SECONDS)}) disagree (P7-07).`,
  );
}

/**
 * The retention purge (P7-07, §3.9): each winery's transcripts past its
 * retention period, and widget events past theirs. In the VPC with the database
 * URL and nothing else; it deletes rows and reads no secret besides.
 *
 * Run by hand with `{ "dryRun": true }` to see what a night would take.
 */
export const retentionPurge = new sst.aws.Cron('RetentionPurge', {
  schedule: RETENTION_SCHEDULE,
  function: {
    handler: 'apps/worker/src/retention.handler',
    architecture: 'arm64',
    runtime: 'nodejs22.x',
    memory: '256 MB',
    timeout: RETENTION_TIMEOUT,
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
 * A night with no run reported. **Missing data is breaching**: a purge that
 * stopped is a compliance problem that grows by a day's transcripts every day,
 * and makes no noise of its own.
 *
 * On runs, not on what was deleted, which is where this departs from the row.
 * "A week without a deletion" is every winery's first ninety days and any quiet
 * week after; it would fire until it was muted. A run that never reports is
 * what a dead job looks like, and `ScheduledJobErrors` is what a failing one does.
 */
new aws.cloudwatch.MetricAlarm('RetentionPurgeSilent', {
  alarmDescription:
    'The retention purge reported no run for a day. Transcripts past their period are being ' +
    'kept, which §3.9 says they are not (P7-07).',
  namespace: RETENTION_METRIC_NAMESPACE,
  metricName: RETENTION_RUNS_METRIC,
  dimensions: { Stage: $app.stage },
  statistic: 'Sum',
  period: RETENTION_SILENCE_SECONDS,
  evaluationPeriods: 1,
  threshold: 1,
  comparisonOperator: 'LessThanThreshold',
  treatMissingData: 'breaching',
  ...notify,
});
