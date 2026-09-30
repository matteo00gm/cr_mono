import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { DomainClaimStatus } from './domain-claims.js';
import { asDate, type SqlTimestamp } from './timestamps.js';
import { getCurrentTenantId, type DbTransaction } from './with-tenant.js';

/**
 * The claim sweep's read (P4-18b, an amendment to ADR 0028).
 *
 * **It widens, like the revocation sweep.** The sweep sends every notice,
 * settles every notice that has run out, and tells both wineries how each claim
 * ended — and learning which claims need any of that is itself the read across
 * tenants. There is no winery to scope it to.
 *
 * **What bounds it is in the policy, not here.** The flag's branch on
 * `domain_claims` admits a claim on notice, and a settled or withdrawn claim
 * whose outcome has not been told — nothing else. And the transaction is `READ
 * ONLY`: every write the sweep makes afterwards is made as the claimant or the
 * holder, under the ordinary tenant policy.
 */
export const CLAIM_SWEEPER_GUC = 'app.claim_sweeper';

/** How many claims one read returns. Claims are rare; this is a ceiling, not a batch. */
export const CLAIM_SWEEP_LIMIT = 50;

/** One claim the sweep has something to do for. */
export interface ClaimWork {
  readonly id: string;
  readonly claimantTenantId: string;
  /** Null for an origin nobody held: nobody to tell. */
  readonly incumbentTenantId: string | null;
  readonly origin: string;
  readonly status: DomainClaimStatus;
  /** Which state was last told, if any. */
  readonly notifiedStatus: DomainClaimStatus | null;
  /** A notice that has been sent and has run out, so it can be settled now. */
  readonly due: boolean;
}

/** Refused rather than merged, for ADR 0022's reason. */
export class NestedClaimSweepContextError extends Error {
  constructor(tenantId: string) {
    super(
      `Cannot read the claim sweep's work inside withTenant("${tenantId}"). With both set, the ` +
        "claims policy's tenant and sweep branches are OR-ed, and a tenant-scoped read would see " +
        'claims across every winery.',
    );
    this.name = 'NestedClaimSweepContextError';
  }
}

interface WorkSqlRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly incumbent_tenant_id: string | null;
  readonly origin: string;
  readonly status: DomainClaimStatus;
  readonly notified_status: DomainClaimStatus | null;
  readonly due: boolean;
}

/**
 * The claims with something to do: a notice not yet sent, a notice sent and
 * run out, or an outcome not yet told.
 *
 * A notice sent and still running is in the policy's reach but not here — it
 * needs nothing until its time is up — so the statement narrows further than
 * the branch has to.
 */
export const readClaimWork = async (
  limit: number = CLAIM_SWEEP_LIMIT,
  db: Database = getDb(),
): Promise<readonly ClaimWork[]> => {
  const activeTenant = getCurrentTenantId();
  if (activeTenant !== undefined) throw new NestedClaimSweepContextError(activeTenant);

  return db.transaction(
    async (tx: DbTransaction) => {
      await tx.execute(sql`SELECT set_config(${CLAIM_SWEEPER_GUC}, 'on', true)`);

      const rows = await tx.execute(sql`
        SELECT id, tenant_id, incumbent_tenant_id, origin, status, notified_status,
               (status = 'NOTICE' AND notified_at IS NOT NULL AND transfer_at <= now()) AS due
        FROM domain_claims
        WHERE (status = 'NOTICE' AND (notified_at IS NULL OR transfer_at <= now()))
           OR (status IN ('TRANSFERRED', 'CANCELED') AND notified_status IS DISTINCT FROM status)
        ORDER BY updated_at, id
        LIMIT ${limit}
      `);

      return [...rows].map((row) => {
        const r = row as unknown as WorkSqlRow;

        return {
          id: r.id,
          claimantTenantId: r.tenant_id,
          incumbentTenantId: r.incumbent_tenant_id,
          origin: r.origin,
          status: r.status,
          notifiedStatus: r.notified_status,
          due: r.due,
        };
      });
    },
    { accessMode: 'read only' },
  );
};

/**
 * Records that a claim's current state has been told, as the claimant.
 *
 * **Conditional on the state not having changed** since the sweep read it: a
 * notice withdrawn while its email was being sent is not stamped as a notice.
 *
 * **A notice's clock starts here.** `transfer_at` is reset to this moment plus
 * the notice period, so the holder gets the whole of it from when it was told —
 * not from when the claim was proven, which may have been before any mail went
 * out. Returns the deadline for a notice, and `null` otherwise; `undefined`
 * when nothing was stamped.
 */
export const markClaimNotified = async (
  tx: DbTransaction,
  id: string,
  status: DomainClaimStatus,
  noticeHours: number,
): Promise<Date | null | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE domain_claims
    SET notified_status = status,
        notified_at = now(),
        transfer_at = CASE
          WHEN status = 'NOTICE' THEN now() + make_interval(hours => ${noticeHours})
          ELSE transfer_at
        END
    WHERE id = ${id}::uuid
      AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND status = ${status}::domain_claim_status
      AND notified_status IS DISTINCT FROM status
    RETURNING status, transfer_at
  `);

  const row = [...rows][0] as
    { status: DomainClaimStatus; transfer_at: SqlTimestamp | null } | undefined;

  if (row === undefined) return undefined;

  return row.status === 'NOTICE' && row.transfer_at !== null ? asDate(row.transfer_at) : null;
};

/**
 * Who an owner's mail goes to, in one winery, and how to address them.
 *
 * A domain claim's (P4-18b) and a failed payment's (P5-05a): both are an
 * owner's business, as the domains and billing screens are.
 */
export interface OwnerRecipients {
  readonly tenantName: string;
  readonly locale: string;
  /** Every owner's address. */
  readonly owners: readonly string[];
}

/**
 * A winery's name, locale and owners, read on the caller's `withTenant`.
 *
 * `auth_users` carries no policy, but the join starts from `memberships`, which
 * does — so this reaches the owners of the winery that is set and nobody else.
 * Returns `undefined` for a winery that no longer exists.
 */
export const readOwnerRecipients = async (
  tx: DbTransaction,
): Promise<OwnerRecipients | undefined> => {
  const tenants = await tx.execute(sql`SELECT name, locale FROM tenants LIMIT 1`);
  const tenant = [...tenants][0] as { name: string; locale: string } | undefined;

  if (tenant === undefined) return undefined;

  const owners = await tx.execute(sql`
    SELECT u.email FROM memberships m
    JOIN auth_users u ON u.id = m.user_id
    WHERE m.role = 'OWNER'
    ORDER BY u.email
  `);

  return {
    tenantName: tenant.name,
    locale: tenant.locale,
    owners: [...owners].map((row) => (row as { email: string }).email),
  };
};
