import { sql } from 'drizzle-orm';

import { getDb, type Database } from './client.js';
import type { tenantPlan, tenantStatus } from './schema/tenants.js';
import { getCurrentTenantId, type DbTransaction } from './with-tenant.js';

/**
 * The server-to-server resolution scope (P4-10, ADR 0026).
 *
 * **The seventh RLS context, and the narrowest.** A seller's server presents a
 * secret key and no tenant — the key *is* how the tenant is identified — and
 * every table it needs is under a forced tenant policy, so a lookup with no
 * context returns nothing. Migration `0049` gives `widget_keys` one branch that
 * admits the single active row whose hash is the one presented.
 *
 * **It finds the tenant and then stops being itself.** Having read that row, it
 * clears the secret GUC and sets `app.tenant_id` from the row, in the same
 * transaction — so everything after is read under the ordinary tenant policy,
 * and no other table ever needed a branch.
 *
 * **Read only**, as `withWidgetKey` is: the path is driven by an
 * unauthenticated caller until the key verifies.
 */

export const SECRET_KEY_GUC = 'app.secret_key_hash';

type TenantStatus = (typeof tenantStatus.enumValues)[number];
type TenantPlan = (typeof tenantPlan.enumValues)[number];

/** What the key resolved to. Nothing about the key itself. */
export interface SecretKeyTenant {
  readonly tenantId: string;
  readonly status: TenantStatus;
  readonly plan: TenantPlan | null;
  readonly locale: string;
  /** Every origin this tenant has verified, which is the set a session may be minted for. */
  readonly verifiedOrigins: readonly string[];
}

/** An empty hash would match no row and look exactly like an unknown key. */
export class InvalidSecretKeyScopeError extends Error {
  constructor() {
    super(
      'A secret-key scope needs the hash of a presented key. An empty one matches no row, ' +
        'and would come back looking exactly like a key that does not exist.',
    );
    this.name = 'InvalidSecretKeyScopeError';
  }
}

/** Refused rather than merged, for ADR 0022's reason. */
export class NestedSecretKeyContextError extends Error {
  constructor(tenantId: string) {
    super(
      `Cannot open a secret-key scope inside withTenant("${tenantId}"). With both set, the ` +
        "key policy's tenant and secret branches are OR-ed, so a tenant-scoped read could see " +
        "another tenant's key row.",
    );
    this.name = 'NestedSecretKeyContextError';
  }
}

/**
 * The tenant a secret key belongs to, with what a session mint needs — or
 * `undefined` for a key that is unknown, revoked, or rotated away from.
 *
 * One answer for all three, and deliberately: a caller that could tell "no
 * such key" from "that key was revoked" could confirm a leaked key had once
 * been real.
 */
export const resolveTenantBySecretKey = async (
  secretKeyHash: string,
  db: Database = getDb(),
): Promise<SecretKeyTenant | undefined> => {
  if (secretKeyHash.trim() === '') throw new InvalidSecretKeyScopeError();

  const activeTenant = getCurrentTenantId();
  if (activeTenant !== undefined) throw new NestedSecretKeyContextError(activeTenant);

  return db.transaction(
    async (tx: DbTransaction) => {
      await tx.execute(sql`SELECT set_config(${SECRET_KEY_GUC}, ${secretKeyHash}, true)`);

      /*
       * `revoked_at IS NULL` here as well as in the policy. The policy is the
       * guarantee; saying it again in the statement means a reader of this file
       * does not have to open a migration to learn that a rotated-away key does
       * not answer.
       */
      const keys = await tx.execute(sql`
        SELECT tenant_id FROM widget_keys
        WHERE secret_key_hash = ${secretKeyHash} AND revoked_at IS NULL
        LIMIT 1
      `);

      const key = [...keys][0] as { tenant_id?: string } | undefined;

      if (key?.tenant_id === undefined) return undefined;

      /*
       * **Hand over, and let go of the key.** Clearing the secret GUC before
       * setting the tenant means this transaction is, from here on, exactly a
       * `withTenant` — the widened branch is open for one statement and never
       * at the same time as a tenant context.
       */
      await tx.execute(
        sql`SELECT set_config(${SECRET_KEY_GUC}, '', true), set_config('app.tenant_id', ${key.tenant_id}, true)`,
      );

      const tenants = await tx.execute(sql`SELECT status, plan, locale FROM tenants LIMIT 1`);
      const tenant = [...tenants][0] as
        { status: TenantStatus; plan: TenantPlan | null; locale: string } | undefined;

      if (tenant === undefined) return undefined;

      const origins = await tx.execute(sql`
        SELECT origin FROM tenant_domains WHERE status = 'VERIFIED' ORDER BY origin
      `);

      return {
        tenantId: key.tenant_id,
        status: tenant.status,
        plan: tenant.plan,
        locale: tenant.locale,
        verifiedOrigins: [...origins].map((row) => (row as { origin: string }).origin),
      };
    },
    { accessMode: 'read only' },
  );
};
