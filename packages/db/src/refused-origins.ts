import { sql } from 'drizzle-orm';

import type { DbTransaction } from './with-tenant.js';

/**
 * The sites that tried to use a winery's widget and were refused (P6-05,
 * §3.2), read in the scope's tenant from `security_events`.
 *
 * **Only the refusals that name this winery**: an `UNAUTHORIZED_ORIGIN`
 * carries the tenant whose key was presented from an origin it does not hold
 * (P2-16). A key that matched nobody is `INVALID_KEY`, belongs to no tenant,
 * and is not readable here at all — the policy leaves those to `app_admin`.
 *
 * **With what became of each origin since**: an origin the winery has added
 * in the meantime is joined from `tenant_domains` under the same scope, so the
 * panel can say "in verifica" rather than offer to add it again.
 */

export interface RefusedOriginsQuery {
  readonly start: Date;
  /** The first instant not counted: the range is `[start, end)`. */
  readonly end: Date;
  readonly limit: number;
}

export interface RefusedOrigin {
  /** The Origin header as the browser sent it. */
  readonly origin: string;
  readonly attempts: number;
  /** Distinct visitor buckets (P2-04): one busy page, or many places. */
  readonly sources: number;
  readonly lastSeenAt: Date;
  /** The winery's own record of it since, if any. */
  readonly domainStatus: 'PENDING' | 'VERIFIED' | null;
}

export const readRefusedOrigins = async (
  tx: DbTransaction,
  { start, end, limit }: RefusedOriginsQuery,
): Promise<RefusedOrigin[]> => {
  const rows = await tx.execute(sql`
    select
      e.origin,
      count(*)::int as attempts,
      count(distinct e.ip_bucket)::int as sources,
      max(e.created_at) as last_seen_at,
      d.status as domain_status
    from security_events e
    left join tenant_domains d on d.origin = e.origin
    where e.tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      and e.type = 'UNAUTHORIZED_ORIGIN'
      and e.origin is not null
      and e.created_at >= ${start.toISOString()}::timestamptz
      and e.created_at < ${end.toISOString()}::timestamptz
    group by e.origin, d.status
    order by attempts desc, last_seen_at desc, e.origin
    limit ${limit}::int
  `);

  return [...rows].map((row) => ({
    origin: String(row.origin),
    attempts: Number(row.attempts),
    sources: Number(row.sources),
    lastSeenAt: new Date(row.last_seen_at as string | Date),
    domainStatus:
      row.domain_status === 'PENDING' || row.domain_status === 'VERIFIED'
        ? row.domain_status
        : null,
  }));
};
