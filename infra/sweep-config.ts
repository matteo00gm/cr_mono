/**
 * The sweep's numbers (P2-14).
 *
 * Apart from `schedules.ts` for the reason `queue-config.ts` is apart from
 * `queue.ts`: that module constructs SST resources at import time and cannot be
 * loaded outside a deploy, so nothing could check what it was built from.
 */

/** Every fifteen minutes, as the row asks. */
export const SWEEP_SCHEDULE = 'rate(15 minutes)' as const;

/**
 * Two minutes.
 *
 * Fifty batches of a thousand rows per table is the most one run deletes, well
 * inside it. And far inside the interval, so two runs never overlap and the
 * sweep never holds more than one connection.
 */
export const SWEEP_TIMEOUT_SECONDS = 120;

/**
 * A day with no row deleted alarms, the row's threshold.
 *
 * A run that never reports counts as one that deleted nothing, so a dead
 * schedule alarms the same way as a sweep that runs and reaches no rows.
 */
export const SWEEP_SILENCE_SECONDS = 86_400;

/** What `apps/worker/src/sweep.ts` writes into its log line and the alarm reads. A contract. */
export const SWEEP_METRIC_NAMESPACE = 'Catalogorosso/Sweep';
export const SWEEP_DELETED_METRIC = 'DeletedRows';

/** The seconds between two runs, read from the schedule itself so the two cannot disagree. */
export const scheduleIntervalSeconds = (schedule: string = SWEEP_SCHEDULE): number => {
  const match = /^rate\((\d+) (minute|minutes|hour|hours)\)$/.exec(schedule);

  if (match === null) {
    throw new Error(`The sweep schedule "${schedule}" is not a rate this module can read (P2-14).`);
  }

  const [, amount = '0', unit = ''] = match;

  return Number(amount) * (unit.startsWith('hour') ? 3600 : 60);
};

/**
 * Throws when a run could outlast the gap before the next.
 *
 * Called at synth time. Two overlapping runs would each hold a connection and
 * race to delete the same batch, which is harmless to the data and not to a
 * connection budget that assumed one.
 */
export const assertSweepFitsSchedule = (
  timeoutSeconds: number = SWEEP_TIMEOUT_SECONDS,
  schedule: string = SWEEP_SCHEDULE,
): void => {
  const interval = scheduleIntervalSeconds(schedule);

  if (timeoutSeconds >= interval) {
    throw new Error(
      `The sweep's timeout (${String(timeoutSeconds)}s) is not inside its schedule ` +
        `(${String(interval)}s between runs), so two runs could overlap (P2-14).`,
    );
  }
};
