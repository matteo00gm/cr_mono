import process from 'node:process';

import {
  countPurgeable,
  listTenantDirectory,
  PRUNE_BATCH,
  purgeConversations,
  purgeWidgetEvents,
  readTranscriptRetention,
  withTenant,
  type TenantDirectoryEntry,
} from '@catalogorosso/db';

import {
  drain,
  MAX_SWEEP_PASSES,
  type DrainOptions,
  type Prune,
  type TableSweep,
} from './sweep.js';

/**
 * The retention purge (P7-07, §3.9): what shoppers typed is kept for as long as
 * their winery said, and then it is not kept.
 *
 * **Transcripts by each winery's own period** — ninety days unless it chose
 * another (`tenants.transcript_retention_days`, migration 0078) — counted from a
 * conversation's last message, and its messages go with it. **Widget events on
 * a longer, fixed horizon**: they hold no words, only that a card was shown or
 * a bottle added, and a seller comparing this autumn with last needs a year
 * and a bit of them.
 *
 * **Per winery, in its own scope**, from the tenant directory (ADR 0030), as
 * the usage rollup is: there is no statement here that can reach two wineries.
 * **In batches**, oldest first, each in a transaction of its own, so nothing
 * holds a winery's conversations locked for longer than a batch takes.
 *
 * **Not `security_events`.** The row asks for them on a longer horizon still,
 * and the runtime role cannot delete from them: they are append-only at the
 * grant level so that whoever holds its credentials cannot erase the record of
 * what they did (P0-31, migration 0019). A purge there needs a path that
 * deletes from a ledger, which is a design change of its own. Until then they
 * are an operator's, in the GDPR runbook (P7-08).
 *
 * **A dry run** reads what would go, per winery, and deletes nothing:
 * `{ "dryRun": true }` as the invocation's event.
 */

/** Ninety days, unless a winery chose otherwise (§3.9). */
export const DEFAULT_TRANSCRIPT_RETENTION_DAYS = 90;

/**
 * Thirteen months and a bit: a year-on-year comparison of the same month, with
 * room for the month to be over. Events carry no words a person wrote.
 */
export const WIDGET_EVENT_RETENTION_DAYS = 400;

/** CloudWatch reads these out of the run's own line (Embedded Metric Format). */
export const RETENTION_METRIC_NAMESPACE = 'Catalogorosso/Retention';
export const RETENTION_RUNS_METRIC = 'Runs';
export const RETENTION_PURGED_METRIC = 'PurgedRows';

const DAY_MS = 86_400_000;

export interface PurgePorts {
  readonly listTenants?: (() => Promise<readonly TenantDirectoryEntry[]>) | undefined;
  /** A winery's chosen period in days, or null for the default. */
  readonly readRetention?: ((tenantId: string) => Promise<number | null>) | undefined;
  /** One batch of a winery's conversations last active before `before`. */
  readonly purgeConversations?: ((tenantId: string, before: Date) => Prune) | undefined;
  readonly purgeEvents?: ((tenantId: string, before: Date) => Prune) | undefined;
  readonly countPurgeable?:
    | ((
        tenantId: string,
        before: { readonly conversations: Date; readonly events: Date },
      ) => Promise<{ conversations: number; events: number }>)
    | undefined;
}

export interface PurgeOptions extends PurgePorts, DrainOptions {
  readonly now?: (() => Date) | undefined;
  /** Count what would go, and delete nothing. */
  readonly dryRun?: boolean | undefined;
}

export interface PurgeResult {
  readonly dryRun: boolean;
  readonly tenants: number;
  /** Deleted, or in a dry run, what would have been. */
  readonly conversations: number;
  readonly events: number;
  /** False when some winery's purge stopped at the pass cap with rows still to go. */
  readonly drained: boolean;
  /** Wineries whose purge threw; the run fails when this is not nought. */
  readonly failed: number;
  readonly firstFailure?: unknown;
}

/** The instant before which a winery's transcripts go. */
export const transcriptCutoff = (now: Date, days: number | null): Date =>
  new Date(now.getTime() - (days ?? DEFAULT_TRANSCRIPT_RETENTION_DAYS) * DAY_MS);

export const eventCutoff = (now: Date): Date =>
  new Date(now.getTime() - WIDGET_EVENT_RETENTION_DAYS * DAY_MS);

export const purgeRetained = async ({
  now = () => new Date(),
  dryRun = false,
  listTenants = () => listTenantDirectory(),
  readRetention = (tenantId) => withTenant(tenantId, readTranscriptRetention),
  purgeConversations: purgeTranscripts = (tenantId, before) => (limit) =>
    withTenant(tenantId, (tx) => purgeConversations(tx, { before, limit })),
  purgeEvents = (tenantId, before) => (limit) =>
    withTenant(tenantId, (tx) => purgeWidgetEvents(tx, { before, limit })),
  countPurgeable: count = (tenantId, before) =>
    withTenant(tenantId, (tx) =>
      countPurgeable(tx, {
        conversationsBefore: before.conversations,
        eventsBefore: before.events,
      }),
    ),
  limit = PRUNE_BATCH,
  maxPasses = MAX_SWEEP_PASSES,
}: PurgeOptions = {}): Promise<PurgeResult> => {
  /* One clock for the whole run, so every winery is cut at the same instant. */
  const at = now();
  const events = eventCutoff(at);
  const tenants = await listTenants();
  let conversations = 0;
  let eventCount = 0;
  let drained = true;
  let failed = 0;
  let firstFailure: unknown;

  for (const tenant of tenants) {
    try {
      const transcripts = transcriptCutoff(at, await readRetention(tenant.id));

      if (dryRun) {
        const would = await count(tenant.id, { conversations: transcripts, events });

        conversations += would.conversations;
        eventCount += would.events;
        continue;
      }

      const swept: TableSweep[] = [
        await drain(purgeTranscripts(tenant.id, transcripts), { limit, maxPasses }),
        await drain(purgeEvents(tenant.id, events), { limit, maxPasses }),
      ];

      conversations += swept[0]?.deleted ?? 0;
      eventCount += swept[1]?.deleted ?? 0;
      drained &&= swept.every((sweep) => sweep.drained);
    } catch (error) {
      failed += 1;
      firstFailure ??= error;
    }
  }

  return {
    dryRun,
    tenants: tenants.length,
    conversations,
    events: eventCount,
    drained,
    failed,
    firstFailure,
  };
};

/** Some wineries could not be purged; the rest were. */
export class PurgeFailedError extends Error {
  constructor(failed: number, cause: unknown) {
    super(
      `The retention purge failed for ${String(failed)} wineries; the rest were purged (P7-07).`,
      {
        cause,
      },
    );
    this.name = 'PurgeFailedError';
  }
}

/**
 * The run's one log line, which is also its metrics.
 *
 * **A run is counted whatever it deleted.** A purge that finds nothing to take
 * is the normal state of a winery younger than its retention period, so "a run
 * that deleted nothing" is not the signal a dead job gives; a run that never
 * reported is (`RetentionPurgeSilent`). A dry run reports and is not counted as
 * a run, so a check by hand cannot hide a schedule that has stopped.
 */
export const metricLine = (result: PurgeResult, stage: string, now: number = Date.now()): string =>
  JSON.stringify({
    _aws: {
      Timestamp: now,
      CloudWatchMetrics: [
        {
          Namespace: RETENTION_METRIC_NAMESPACE,
          Dimensions: [['Stage']],
          Metrics: [
            { Name: RETENTION_RUNS_METRIC, Unit: 'Count' },
            { Name: RETENTION_PURGED_METRIC, Unit: 'Count' },
          ],
        },
      ],
    },
    Stage: stage,
    [RETENTION_RUNS_METRIC]: result.dryRun ? 0 : 1,
    [RETENTION_PURGED_METRIC]: result.dryRun ? 0 : result.conversations + result.events,
    event: result.dryRun ? 'retention.dry_run' : 'retention.completed',
    tenants: result.tenants,
    conversations: result.conversations,
    events: result.events,
    drained: result.drained,
    failed: result.failed,
  });

export interface HandlerOptions extends PurgeOptions {
  readonly log?: ((line: string) => void) | undefined;
}

const askedForDryRun = (event: unknown): boolean =>
  (event as { dryRun?: unknown } | null | undefined)?.dryRun === true;

/** The Lambda entry point, nightly (`infra/schedules.ts`), or by hand with `{ "dryRun": true }`. */
export const handler = async (
  event?: unknown,
  _context?: unknown,
  { log = (line) => process.stdout.write(`${line}\n`), ...options }: HandlerOptions = {},
): Promise<PurgeResult> => {
  const result = await purgeRetained({ dryRun: askedForDryRun(event), ...options });

  log(metricLine(result, process.env.SST_STAGE ?? 'unknown'));

  if (result.failed > 0) throw new PurgeFailedError(result.failed, result.firstFailure);

  return result;
};
