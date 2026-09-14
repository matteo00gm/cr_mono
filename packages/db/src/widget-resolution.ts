import { sql } from 'drizzle-orm';

import type { Database } from './client.js';
import type { tenantPlan, tenantStatus } from './schema/tenants.js';
import { withWidgetKey } from './with-widget-key.js';

/**
 * The allowlist accessor (P2-07, §3.2).
 *
 * **The single chokepoint for the rule that `pk_` and `Origin` must agree on one
 * tenant.** Being one function is also what makes adding a cache later purely
 * additive (§5.7): today every call is a query, so a domain removed is refused
 * on the very next request.
 *
 * `origin` must already be normalised (P2-05). The comparison below is exact
 * equality against the stored serialised origin — never a pattern — and a raw
 * `Origin` header compared here would miss on case alone.
 */

export type TenantStatus = (typeof tenantStatus.enumValues)[number];
export type TenantPlan = (typeof tenantPlan.enumValues)[number];

export type WidgetResolution =
  | {
      readonly found: true;
      readonly tenantId: string;
      readonly status: TenantStatus;
      readonly plan: TenantPlan | null;
      readonly locale: string;
    }
  /**
   * No usable key: never issued, or revoked and past its grace window.
   * Nothing is known about a tenant, so there is none to report.
   */
  | { readonly found: false; readonly reason: 'unknown_key' }
  /**
   * A real key from an origin its tenant has not verified — the signature of
   * widget theft (§3.2). The tenant is reported **for our logs only**: P2-16
   * counts `UNAUTHORIZED_ORIGIN` against it. The response a caller gets must be
   * identical to `unknown_key`, or this becomes an oracle for which keys exist.
   */
  | { readonly found: false; readonly reason: 'origin_mismatch'; readonly tenantId: string };

interface ResolutionRow {
  readonly tenant_id: string;
  readonly usable: boolean;
  readonly domain_id: string | null;
  readonly status: TenantStatus | null;
  readonly plan: TenantPlan | null;
  readonly locale: string | null;
}

export const resolveTenantByKeyAndOrigin = (
  publicKey: string,
  origin: string,
  db?: Database,
): Promise<WidgetResolution> =>
  withWidgetKey(
    publicKey,
    origin,
    async (tx): Promise<WidgetResolution> => {
      /*
       * One statement, starting from the key. The domain and the tenant are LEFT
       * joined so that "the key exists and the origin does not" is a row with
       * nulls rather than no row — which is the whole difference between the
       * two refusals, read in one round trip.
       *
       * No tenant predicate is written, and none is missing: the policies admit
       * exactly this key's row, the domain whose origin matches *for that key's
       * tenant*, and the tenant only behind a verified domain. The joins restate
       * the tenant relationship so the query also reads correctly on its own.
       */
      const rows = await tx.execute(sql`
        SELECT
          k.tenant_id,
          (k.revoked_at IS NULL OR k.grace_until > now()) AS usable,
          d.id AS domain_id,
          t.status,
          t.plan,
          t.locale
        FROM widget_keys k
        LEFT JOIN tenant_domains d
          ON d.tenant_id = k.tenant_id
          AND d.origin = ${origin}
          AND d.status = 'VERIFIED'
        LEFT JOIN tenants t ON t.id = d.tenant_id
        WHERE k.public_key = ${publicKey}
      `);

      const row = [...rows][0] as ResolutionRow | undefined;

      /*
       * A revoked key past its grace window reads as never issued. Rotation is
       * how a leaked key is retired (§3.2), and a retired key presenting itself
       * is not a theft signal about any origin.
       */
      if (!row?.usable) return { found: false, reason: 'unknown_key' };

      if (row.domain_id === null) {
        return { found: false, reason: 'origin_mismatch', tenantId: row.tenant_id };
      }

      /*
       * A verified domain whose tenant row is invisible means the policies and
       * this query disagree. That is a bug in migration 0042 or here, not a
       * refusal to hand a caller, and answering `origin_mismatch` would hide it.
       */
      if (row.status === null || row.locale === null) {
        throw new Error(
          'resolveTenantByKeyAndOrigin: a verified domain matched but its tenant row is not ' +
            'visible under the widget scope — the policies in migration 0042 and this query disagree.',
        );
      }

      return {
        found: true,
        tenantId: row.tenant_id,
        status: row.status,
        plan: row.plan,
        locale: row.locale,
      };
    },
    db,
  );
