import { sql } from 'drizzle-orm';

import { insertAuditRow } from './audit.js';
import { getDb, type Database } from './client.js';
import {
  deleteDomain,
  insertVerifiedSibling,
  readDomainByOrigin,
  type DomainRow,
} from './domains-write.js';
import type { tenantStatus } from './schema/tenants.js';
import { endSessionsFor } from './session-cutoffs.js';
import { asDate, type SqlTimestamp } from './timestamps.js';
import { getCurrentTenantId, type DbTransaction } from './with-tenant.js';

/**
 * Settling a proven claim on an origin another winery holds (P4-18, ADR 0028)
 * — the **eighth** RLS context.
 *
 * **The one place a winery's domain row is reached from another winery's
 * request.** Everything else about this system is built so that cannot happen,
 * which is why P4-01 can only ever say "not available". A claim needs the
 * holder's row — to learn whether the holder is paying, and then to move the
 * origin — so this scope reaches exactly that row, and only once the claimant
 * has proved control of the zone by DNS.
 *
 * **What bounds it is in the policy, not here.** `app.domain_claim` names a
 * claim, and the branch on `tenant_domains` admits the one domain whose origin
 * that claim names — only if the claim is visible to the tenant that is set, and
 * only if it is `PROVEN` or its notice has run out. So a claim still waiting for
 * its TXT record, a notice with time left on it and a withdrawn claim reach
 * nothing, whatever this file does.
 *
 * **It reads the holder and then stops being itself.** The GUC is set for one
 * statement and cleared in the next, which also moves `app.tenant_id` to the
 * holder: everything after is the holder's ordinary tenant scope, and then the
 * claimant's again. It is one transaction because the plan asks for exactly
 * that — the holder's row goes, the claimant's arrives, and both audit rows are
 * written, or none of it happens.
 *
 * **A closed operation, not a callback.** `withTenant` hands its caller a
 * transaction to do what it likes in; this does not, so nothing can run inside
 * the widened branch that is not written here.
 */

export const CLAIM_GUC = 'app.domain_claim';

type TenantStatus = (typeof tenantStatus.enumValues)[number];

/**
 * Holders who lose the origin at once. Nothing is being served for them: the
 * account is switched off, cancelled, or never finished signing up.
 */
const LAPSED: ReadonlySet<TenantStatus> = new Set(['DISABLED', 'CANCELED', 'PENDING_VERIFICATION']);

/** Who asked, for the claimant's audit row. Never written to the holder's. */
export interface ClaimActor {
  readonly userId?: string | undefined;
  readonly ip?: string | undefined;
  readonly userAgent?: string | undefined;
}

export interface SettleClaim {
  readonly claimId: string;
  /** From a `memberships` row, never from the request (P0-48). */
  readonly claimantTenantId: string;
  /** The claimant's plan cap, in registrable domains (P4-07). */
  readonly cap: number;
  /**
   * How long a paying holder has to answer. A rule, so it is `core`'s
   * (`CLAIM_NOTICE_HOURS`); this file only writes the deadline it is given.
   */
  readonly noticeHours: number;
  readonly actor: ClaimActor;
}

/**
 * Why an origin moved. Recorded in both audit rows; never shown to the claimant,
 * who is told only that it did.
 */
export type TransferBasis = 'unheld' | 'already-held' | 'unverified' | 'lapsed' | 'notice-expired';

export type ClaimSettlement =
  /** Not this winery's claim, not proven, on notice with time left, or already settled. */
  | { readonly kind: 'unsettleable' }
  | { readonly kind: 'at-cap'; readonly held: number }
  | { readonly kind: 'transferred'; readonly domain: DomainRow; readonly basis: TransferBasis }
  | { readonly kind: 'noticed'; readonly transferAt: Date };

/**
 * Somebody took the origin between our read and our write.
 *
 * Thrown rather than returned, so the transaction rolls back: by the time it
 * can happen the holder's row may already be gone, and committing that without
 * the claimant's arriving would hand the origin to nobody.
 */
export class ClaimRacedError extends Error {
  constructor() {
    super('The origin changed hands while the claim was being settled. Nothing was moved.');
    this.name = 'ClaimRacedError';
  }
}

/** Refused rather than merged, for ADR 0022's reason. */
export class NestedClaimContextError extends Error {
  constructor(tenantId: string) {
    super(
      `Cannot settle a domain claim inside withTenant("${tenantId}"). The claim scope moves ` +
        'app.tenant_id between two wineries, and a caller holding a transaction open on one of ' +
        'them would be reading under whichever it happened to be set to.',
    );
    this.name = 'NestedClaimContextError';
  }
}

const setTenant = async (tx: DbTransaction, tenantId: string): Promise<void> => {
  await tx.execute(sql`SELECT set_config('app.tenant_id', ${tenantId}, true)`);
};

/** Our own enum values, so there is nothing in them for the redactor to find. */
const basisMetadata = (basis: TransferBasis | 'notice'): string => JSON.stringify({ kind: basis });

interface ClaimSqlRow {
  readonly origin: string;
  readonly registrable_domain: string;
  readonly status: string;
  readonly incumbent_tenant_id: string | null;
  readonly settleable: boolean;
}

interface HolderSqlRow {
  readonly id: string;
  readonly tenant_id: string;
  readonly status: 'PENDING' | 'VERIFIED';
}

export const settleDomainClaim = async (
  { claimId, claimantTenantId, cap, noticeHours, actor }: SettleClaim,
  db: Database = getDb(),
): Promise<ClaimSettlement> => {
  const activeTenant = getCurrentTenantId();
  if (activeTenant !== undefined) throw new NestedClaimContextError(activeTenant);

  return db.transaction(async (tx: DbTransaction): Promise<ClaimSettlement> => {
    await setTenant(tx, claimantTenantId);

    /*
     * **Locked, so a double click settles once.** The second request waits
     * here, then finds a claim that is no longer settleable. Read under the
     * claimant's own half of the policy, and named by tenant as well: the
     * holder's half would admit a claim served *on* this winery, which is not
     * one it may settle.
     */
    const claims = await tx.execute(sql`
      SELECT origin, registrable_domain, status, incumbent_tenant_id,
             (status = 'PROVEN' OR (status = 'NOTICE' AND transfer_at <= now())) AS settleable
      FROM domain_claims
      WHERE id = ${claimId}::uuid AND tenant_id = ${claimantTenantId}::uuid
      FOR UPDATE
    `);
    const claim = [...claims][0] as ClaimSqlRow | undefined;

    if (claim?.settleable !== true) return { kind: 'unsettleable' };

    /* The notice that ran out, and who it was served on. */
    const noticed = claim.status === 'NOTICE' ? claim.incumbent_tenant_id : null;

    /*
     * The claimant's side first, and under the lock every domain write for this
     * winery takes (P4-07): if the origin cannot land, nothing is taken from
     * the holder. Distinct registrable domains, as the cap counts them — a
     * claim under a domain this winery already holds costs no slot.
     */
    await tx.execute(sql`SELECT 1 FROM tenants FOR UPDATE`);
    const counts = await tx.execute(sql`
      SELECT count(DISTINCT registrable_domain)::int AS held,
             coalesce(bool_or(registrable_domain = ${claim.registrable_domain}), false) AS covered
      FROM tenant_domains
    `);
    const { held, covered } = [...counts][0] as { held: number; covered: boolean };

    const finish = async (domain: DomainRow, basis: TransferBasis): Promise<ClaimSettlement> => {
      await tx.execute(sql`
        UPDATE domain_claims
        SET status = 'TRANSFERRED', settled_at = now()
        WHERE id = ${claimId}::uuid
      `);
      await insertAuditRow(tx, {
        tenantId: claimantTenantId,
        actorUserId: actor.userId,
        action: 'domain.claimed_by_challenge',
        target: claim.origin,
        metadata: basisMetadata(basis),
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      return { kind: 'transferred', domain, basis };
    };

    /*
     * Already this winery's — another claim got there first, or it was added
     * the ordinary way once somebody let it go. Read before the claim GUC is
     * set, so the tenant's own half of the policy is the only half in play.
     */
    const own = await readDomainByOrigin(tx, claim.origin);

    if (own !== undefined) return finish(own, 'already-held');

    if (!covered && held >= cap) return { kind: 'at-cap', held };

    /*
     * **The widened read, and the only one.** The GUC is set, the holder's row
     * is read and locked, and the GUC is cleared in the very next statement.
     * `FOR UPDATE` so a second claimant settling the same origin waits here
     * rather than deleting the row out from under this one.
     */
    await tx.execute(sql`SELECT set_config(${CLAIM_GUC}, ${claimId}, true)`);
    const holders = await tx.execute(sql`
      SELECT id, tenant_id, status FROM tenant_domains WHERE origin = ${claim.origin} FOR UPDATE
    `);
    await tx.execute(sql`SELECT set_config(${CLAIM_GUC}, '', true)`);

    const holder = [...holders][0] as HolderSqlRow | undefined;

    /* The claimant proved the zone, and nobody holds the origin — so it is theirs. */
    const land = async (basis: TransferBasis): Promise<ClaimSettlement> => {
      await setTenant(tx, claimantTenantId);

      const landed = await insertVerifiedSibling(
        tx,
        { origin: claim.origin, registrableDomain: claim.registrable_domain },
        'DNS_TXT',
      );

      if (landed === undefined) throw new ClaimRacedError();

      return finish(landed, basis);
    };

    if (holder === undefined) return land('unheld');

    /* Across to the holder, and nothing but the holder's own policy from here. */
    await setTenant(tx, holder.tenant_id);

    const tenants = await tx.execute(sql`SELECT status FROM tenants LIMIT 1`);
    const holderStatus = ([...tenants][0] as { status: TenantStatus }).status;

    /*
     * **A notice counts only against the winery it was served on.** If the
     * origin changed hands while the notice ran — the holder removed it, and
     * somebody else added it — the new holder has been told nothing, and gets
     * its own 72 hours below rather than inheriting the end of someone else's.
     */
    const basis: TransferBasis | undefined =
      holder.status === 'PENDING'
        ? 'unverified'
        : LAPSED.has(holderStatus)
          ? 'lapsed'
          : noticed === holder.tenant_id
            ? 'notice-expired'
            : undefined;

    if (basis === undefined) {
      /*
       * **A paying holder is put on notice, not dispossessed.** Its row is
       * untouched; its audit log records the claim with no actor, because the
       * actor is a member of another winery and naming them would tell the
       * holder who the claimant is.
       */
      await insertAuditRow(tx, {
        tenantId: holder.tenant_id,
        actorUserId: undefined,
        action: 'domain.claim_noticed',
        target: claim.origin,
        metadata: basisMetadata('notice'),
        ip: undefined,
        userAgent: undefined,
      });

      await setTenant(tx, claimantTenantId);

      const served = await tx.execute(sql`
        UPDATE domain_claims
        SET status = 'NOTICE',
            incumbent_tenant_id = ${holder.tenant_id}::uuid,
            transfer_at = now() + make_interval(hours => ${noticeHours})
        WHERE id = ${claimId}::uuid
        RETURNING transfer_at
      `);
      const transferAt = asDate(([...served][0] as { transfer_at: SqlTimestamp }).transfer_at);

      await insertAuditRow(tx, {
        tenantId: claimantTenantId,
        actorUserId: actor.userId,
        action: 'domain.claim_noticed',
        target: claim.origin,
        metadata: basisMetadata('notice'),
        ip: actor.ip,
        userAgent: actor.userAgent,
      });

      return { kind: 'noticed', transferAt };
    }

    /*
     * **The holder's row goes, and its sessions with it.** A real delete, as
     * P4-06's is: a tombstone would hold the origin against the claimant too.
     * The cutoff is what ends every live session the holder had on it, even
     * once §5.7 caches the allowlist.
     */
    await deleteDomain(tx, holder.id);
    await endSessionsFor(tx, claim.origin);
    await insertAuditRow(tx, {
      tenantId: holder.tenant_id,
      actorUserId: undefined,
      action: 'domain.claimed_by_challenge',
      target: claim.origin,
      metadata: basisMetadata(basis),
      ip: undefined,
      userAgent: undefined,
    });

    return land(basis);
  });
};
