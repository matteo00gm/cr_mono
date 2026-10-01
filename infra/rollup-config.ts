/**
 * The nightly rollup's numbers (P5-13).
 *
 * Apart from `schedules.ts` for `sweep-config.ts`'s reason: that module builds
 * SST resources at import time and cannot be loaded outside a deploy, so
 * nothing could check what it was built from.
 */

/**
 * 01:30 UTC, every night. After midnight in every timezone a seller works in,
 * so "yesterday" is over everywhere it is read; and early, so the dashboard's
 * history is current before anyone in Italy opens it.
 */
export const ROLLUP_SCHEDULE = 'cron(30 1 * * ? *)' as const;

/**
 * Five minutes. A run is one statement per tenant per day — at the product's
 * ceiling of ten tenants, twenty statements — so this is room for a slow
 * database, not for the work.
 */
export const ROLLUP_TIMEOUT_SECONDS = 300;

/**
 * A day with no run reported alarms. The longest period an alarm takes, and a
 * nightly run lands once in every such window, so a window without one is a
 * night that did not run.
 */
export const ROLLUP_SILENCE_SECONDS = 86_400;

/** What `apps/worker/src/rollup.ts` writes into its log line and the alarm reads. A contract. */
export const ROLLUP_METRIC_NAMESPACE = 'Catalogorosso/Rollup';
export const ROLLUP_RUNS_METRIC = 'Runs';
