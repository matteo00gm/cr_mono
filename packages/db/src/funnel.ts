import { sql } from 'drizzle-orm';

import type { WidgetEventInsert } from './contracts.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * The funnel's counts (P6-02, §2.4), read from `widget_events` in the scope's
 * tenant.
 *
 * **A repository function, so what it reads can change underneath.** At launch
 * it reads raw events, which the `(tenant_id, type, created_at)` index serves;
 * once volume asks for it, a date-bucketed aggregate can answer the same
 * question here and nothing above this function will know.
 *
 * **The stages are the caller's.** Which events make a stage, and in what
 * order, is a product decision and lives in `packages/core`; this answers, for
 * each position in the list it is given, how many visits reached that stage or
 * a later one. A visit is the anonymous per-tab id (P3-16) the event was
 * recorded under, and it counts once at its furthest stage — so a visit whose
 * `WIDGET_OPEN` was lost still counts as having opened the widget it bought
 * from, and the funnel never widens.
 */

export interface FunnelQuery {
  /** The stages, in order. */
  readonly stages: readonly WidgetEventInsert['type'][];
  /** The first instant counted. */
  readonly start: Date;
  /** The first instant not counted: the range is `[start, end)`. */
  readonly end: Date;
}

/** For each stage in order, the visits that reached it or a later one. */
export const readFunnel = async (
  tx: DbTransaction,
  { stages, start, end }: FunnelQuery,
): Promise<number[]> => {
  if (stages.length === 0) return [];

  /* One array parameter: Drizzle would spread a JS array into a list of them. */
  const ordered = `{${stages.join(',')}}`;

  const rows = await tx.execute(sql`
    with furthest as (
      select session_id, max(array_position(${ordered}::widget_event_type[], type)) as reached
      from widget_events
      where tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        and type = any(${ordered}::widget_event_type[])
        and created_at >= ${start.toISOString()}::timestamptz
        and created_at < ${end.toISOString()}::timestamptz
      group by session_id
    )
    select stage, count(f.session_id)::int as sessions
    from generate_series(1, ${stages.length}::int) as stage
    left join furthest f on f.reached >= stage
    group by stage
    order by stage
  `);

  return [...rows].map((row) => Number(row.sessions));
};
