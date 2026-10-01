import process from 'node:process';

import {
  listTenantDirectory,
  rollupUsageDay,
  withTenant,
  type TenantDirectoryEntry,
} from '@catalogorosso/db';

/**
 * The nightly rollup (P5-13): every tenant's recent days, recomputed from the
 * ledger into `usage_daily`, which the dashboard's history reads instead of
 * raw events.
 *
 * **A bounded window, recomputed.** Each run rolls up the last `ROLLUP_DAYS`
 * whole UTC days — yesterday, and the day before for a write that landed late —
 * and each day is replaced rather than added to, so a retried or doubled run
 * reports the same numbers. **A row for every tenant and day**, noughts
 * included, from the tenant directory (ADR 0030): a chart reads a missing day
 * as "no data" and draws a line through it.
 *
 * **One tenant failing does not stop the rest**; the run still fails at the
 * end, after it has logged what it did, so the error is seen and the next
 * night recomputes the day anyway.
 */

/** Yesterday, and the day before for a late write. */
export const ROLLUP_DAYS = 2;

/** The most one run may be asked for: a month of backfill, and no more. */
export const MAX_ROLLUP_DAYS = 31;

/** What the run writes into its log line and the alarm reads. A contract with `infra/rollup-config.ts`. */
export const ROLLUP_METRIC_NAMESPACE = 'Catalogorosso/Rollup';
export const ROLLUP_RUNS_METRIC = 'Runs';
export const ROLLUP_ROWS_METRIC = 'RolledUpRows';

const DAY_MS = 86_400_000;

const dayOf = (at: number): string => new Date(at).toISOString().slice(0, 10);

/** The whole UTC days before `now`, oldest first — never today, which is not over. */
export const daysToRollUp = (now: Date, days: number = ROLLUP_DAYS): string[] => {
  if (!Number.isSafeInteger(days) || days < 1 || days > MAX_ROLLUP_DAYS) {
    throw new RangeError(
      `A rollup covers 1 to ${String(MAX_ROLLUP_DAYS)} days, not ${String(days)} (P5-13).`,
    );
  }

  const today = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate());

  return Array.from({ length: days }, (_, index) => dayOf(today - (days - index) * DAY_MS));
};

export interface RollupOptions {
  readonly now?: (() => Date) | undefined;
  readonly days?: number | undefined;
  readonly listTenants?: (() => Promise<readonly TenantDirectoryEntry[]>) | undefined;
  readonly rollupDay?: ((tenantId: string, day: string) => Promise<unknown>) | undefined;
}

export interface RollupResult {
  readonly days: readonly string[];
  readonly tenants: number;
  /** Tenant-days written. */
  readonly rows: number;
  /** Tenant-days that threw; the run fails when this is not nought. */
  readonly failed: number;
  readonly firstFailure?: unknown;
}

export const rollup = async ({
  now = () => new Date(),
  days = ROLLUP_DAYS,
  listTenants = () => listTenantDirectory(),
  rollupDay = (tenantId, day) => withTenant(tenantId, (tx) => rollupUsageDay(tx, day)),
}: RollupOptions = {}): Promise<RollupResult> => {
  const window = daysToRollUp(now(), days);
  const tenants = await listTenants();
  let rows = 0;
  let failed = 0;
  let firstFailure: unknown;

  for (const tenant of tenants) {
    for (const day of window) {
      /* A winery that did not exist by the day's end has no day to report. */
      if (tenant.createdAt.getTime() >= Date.parse(`${day}T00:00:00Z`) + DAY_MS) continue;

      try {
        await rollupDay(tenant.id, day);
        rows += 1;
      } catch (error) {
        failed += 1;
        firstFailure ??= error;
      }
    }
  }

  return { days: window, tenants: tenants.length, rows, failed, firstFailure };
};

/** Some tenant-days could not be rolled up; the rest were. */
export class RollupFailedError extends Error {
  constructor(failed: number, cause: unknown) {
    super(`The rollup failed for ${String(failed)} tenant-days; the rest were written (P5-13).`, {
      cause,
    });
    this.name = 'RollupFailedError';
  }
}

/** The run's one log line, which is also its metrics (Embedded Metric Format). */
export const metricLine = (result: RollupResult, stage: string, now: number = Date.now()): string =>
  JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: ROLLUP_METRIC_NAMESPACE,
          Dimensions: [['Stage']],
          Metrics: [
            { Name: ROLLUP_RUNS_METRIC, Unit: 'Count' },
            { Name: ROLLUP_ROWS_METRIC, Unit: 'Count' },
          ],
        },
      ],
    },
    Stage: stage,
    [ROLLUP_RUNS_METRIC]: 1,
    [ROLLUP_ROWS_METRIC]: result.rows,
    event: 'rollup.completed',
    days: result.days,
    tenants: result.tenants,
    failed: result.failed,
  });

export interface HandlerOptions extends RollupOptions {
  readonly log?: ((line: string) => void) | undefined;
}

/** The Lambda entry point, nightly (`infra/schedules.ts`). */
export const handler = async (
  _event?: unknown,
  _context?: unknown,
  { log = (line) => process.stdout.write(`${line}\n`), ...options }: HandlerOptions = {},
): Promise<RollupResult> => {
  const result = await rollup(options);

  log(metricLine(result, process.env.SST_STAGE ?? 'unknown'));

  if (result.failed > 0) throw new RollupFailedError(result.failed, result.firstFailure);

  return result;
};
