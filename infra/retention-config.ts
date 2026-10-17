/**
 * The retention purge's numbers (P7-07).
 *
 * Apart from `schedules.ts` for `rollup-config.ts`'s reason: that module builds
 * SST resources at import time, and nothing could check what it was built from.
 */

/**
 * 02:15 UTC, every night: after the rollup (01:30) has read yesterday, and long
 * before anyone in Italy is awake to be reading a transcript that is about to go.
 */
export const RETENTION_SCHEDULE = 'cron(15 2 * * ? *)' as const;

/**
 * Five minutes. A night's purge is the conversations that turned ninety days
 * old yesterday, a batch or two per winery; the passes cap what one run takes,
 * and what it leaves is the next night's first batch.
 */
export const RETENTION_TIMEOUT_SECONDS = 300;

/** A day with no run reported alarms, on `rollup-config.ts`'s reasoning. */
export const RETENTION_SILENCE_SECONDS = 86_400;

/** What `apps/worker/src/retention.ts` writes into its log line and the alarm reads. A contract. */
export const RETENTION_METRIC_NAMESPACE = 'Catalogorosso/Retention';
export const RETENTION_RUNS_METRIC = 'Runs';
