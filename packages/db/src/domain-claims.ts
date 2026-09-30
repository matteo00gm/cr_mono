import { sql } from 'drizzle-orm';

import { asDate, asDateOrNull, type SqlTimestamp } from './timestamps.js';
import type { DbTransaction } from './with-tenant.js';

/**
 * A claim on an origin somebody else holds, from the claimant's side (P4-18).
 *
 * Every statement here runs inside the claimant's own `withTenant`, and
 * `domain_claims` is under a policy whose claimant half is the boilerplate — so
 * nothing in this file can see another winery's claim, or learn anything about
 * the holder. Finding the holder is `settleDomainClaim`'s job, in its own scope
 * (ADR 0028), and only once a claim here has been proved.
 */

export type DomainClaimStatus = 'PENDING' | 'PROVEN' | 'NOTICE' | 'TRANSFERRED' | 'CANCELED';

/**
 * A claim as its claimant may see it.
 *
 * **No holder in it, on purpose.** The row carries `incumbent_tenant_id` once a
 * notice is served, and this shape leaves it out: proving control of a zone
 * does not entitle anybody to learn who our customer is.
 */
export interface DomainClaimRow {
  readonly id: string;
  readonly origin: string;
  readonly registrableDomain: string;
  readonly status: DomainClaimStatus;
  readonly verificationToken: string | null;
  readonly verificationExpiresAt: Date | null;
  /** When a paying holder's notice runs out. Null unless the claim is on notice. */
  readonly transferAt: Date | null;
  readonly createdAt: Date;
}

export interface NewDomainClaim {
  readonly origin: string;
  readonly registrableDomain: string;
  readonly verificationToken: string;
}

interface ClaimSqlRow {
  readonly id: string;
  readonly origin: string;
  readonly registrable_domain: string;
  readonly status: DomainClaimStatus;
  readonly verification_token: string | null;
  readonly verification_expires_at: SqlTimestamp | null;
  readonly transfer_at: SqlTimestamp | null;
  readonly created_at: SqlTimestamp;
}

const toClaim = (row: ClaimSqlRow): DomainClaimRow => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrable_domain,
  status: row.status,
  verificationToken: row.verification_token,
  verificationExpiresAt: asDateOrNull(row.verification_expires_at),
  transferAt: asDateOrNull(row.transfer_at),
  createdAt: asDate(row.created_at),
});

/** Never `incumbent_tenant_id`: see `DomainClaimRow`. */
const COLUMNS = sql`
  id, origin, registrable_domain, status,
  verification_token, verification_expires_at, transfer_at, created_at
`;

/** A claim closed while it was being opened again. The request can simply be repeated. */
export class ClaimChangedError extends Error {
  constructor() {
    super('That claim was settled while it was being reopened. Repeat the request.');
    this.name = 'ClaimChangedError';
  }
}

/** Seven days, as a first verification's nonce is and for P4-04's reasons. */
const VERIFICATION_WINDOW = sql`interval '7 days'`;

const first = (rows: Iterable<unknown>): DomainClaimRow | undefined => {
  const row = [...rows][0] as ClaimSqlRow | undefined;

  return row === undefined ? undefined : toClaim(row);
};

/**
 * Opens a claim, or hands back the one already open.
 *
 * **One open claim per winery per origin**, held by a partial unique index, and
 * a second attempt is answered with the first rather than refused. A seller
 * coming back to this screen wants the nonce they already published, and a new
 * one would silently invalidate the TXT record they just added.
 */
export const insertClaim = async (
  tx: DbTransaction,
  claim: NewDomainClaim,
): Promise<{ readonly created: boolean; readonly claim: DomainClaimRow }> => {
  const inserted = first(
    await tx.execute(sql`
      INSERT INTO domain_claims (
        tenant_id, origin, registrable_domain, verification_token, verification_expires_at
      )
      VALUES (
        nullif(current_setting('app.tenant_id', true), '')::uuid,
        ${claim.origin},
        ${claim.registrableDomain},
        ${claim.verificationToken},
        now() + ${VERIFICATION_WINDOW}
      )
      ON CONFLICT (tenant_id, origin) WHERE status IN ('PENDING', 'PROVEN', 'NOTICE') DO NOTHING
      RETURNING ${COLUMNS}
    `),
  );

  if (inserted !== undefined) return { created: true, claim: inserted };

  const open = first(
    await tx.execute(sql`
      SELECT ${COLUMNS} FROM domain_claims
      WHERE origin = ${claim.origin}
        AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND status IN ('PENDING', 'PROVEN', 'NOTICE')
      LIMIT 1
    `),
  );

  /* The conflict was with this winery's own open claim, by the index's own
   * definition, so it is there to be read. Absent means a settlement closed it
   * between the two statements — rare enough that asking again is the answer. */
  if (open === undefined) throw new ClaimChangedError();

  return { created: false, claim: open };
};

/** This winery's claim by id. Another winery's id is no row, under RLS (§3.5). */
export const readClaimById = async (
  tx: DbTransaction,
  id: string,
): Promise<DomainClaimRow | undefined> =>
  first(
    await tx.execute(sql`
      SELECT ${COLUMNS} FROM domain_claims
      WHERE id = ${id}::uuid
        AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      LIMIT 1
    `),
  );

/**
 * Records that the claimant's TXT record was there.
 *
 * **Conditional on the claim still being `PENDING` and still carrying the
 * nonce that was checked**, in the statement itself (P0-52). A caller that read
 * the claim and then updated it would have a guard with a bypass — and this is
 * the write that opens `settleDomainClaim`'s branch onto another winery's row.
 *
 * The nonce is cleared as it is used (P4-04): it sits in a public TXT record,
 * and one that kept working is a proof anybody who reads that record could
 * replay.
 */
export const markClaimProven = async (
  tx: DbTransaction,
  id: string,
  checkedToken: string,
): Promise<DomainClaimRow | undefined> =>
  first(
    await tx.execute(sql`
      UPDATE domain_claims
      SET status = 'PROVEN',
          proven_at = now(),
          verification_token = null,
          verification_expires_at = null
      WHERE id = ${id}::uuid
        AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND status = 'PENDING'
        AND verification_token = ${checkedToken}
      RETURNING ${COLUMNS}
    `),
  );

/** A fresh nonce for a claim whose last one lapsed, for P4-04's reasons. */
export const reissueClaimVerification = async (
  tx: DbTransaction,
  id: string,
  token: string,
): Promise<DomainClaimRow | undefined> =>
  first(
    await tx.execute(sql`
      UPDATE domain_claims
      SET verification_token = ${token},
          verification_expires_at = now() + ${VERIFICATION_WINDOW}
      WHERE id = ${id}::uuid
        AND tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
        AND status = 'PENDING'
      RETURNING ${COLUMNS}
    `),
  );

/* ---- The holder's side (P4-18b) ------------------------------------------- */

/**
 * A claim served on this winery, as its holder may see it.
 *
 * **The origin and the deadline, and nothing about the claimant.** Proving
 * control of a zone does not make the claimant's identity the holder's business
 * any more than the other way round.
 */
export interface ServedClaimRow {
  readonly id: string;
  readonly origin: string;
  readonly transferAt: Date;
}

/**
 * Every notice served on this winery that is still running.
 *
 * Named by the holder column rather than left to the policy, whose other half
 * admits the claims this winery made itself.
 */
export const readServedClaims = async (tx: DbTransaction): Promise<readonly ServedClaimRow[]> => {
  const rows = await tx.execute(sql`
    SELECT id, origin, transfer_at FROM domain_claims
    WHERE incumbent_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND status = 'NOTICE'
    ORDER BY transfer_at, origin
  `);

  return [...rows].map((row) => {
    const r = row as { id: string; origin: string; transfer_at: SqlTimestamp };

    return { id: r.id, origin: r.origin, transferAt: asDate(r.transfer_at) };
  });
};

/**
 * Withdraws a claim served on this winery, keeping its origin.
 *
 * **Only while the claim is on notice**, and only by the winery it was served
 * on — in the statement as well as in the policy, whose holder half would also
 * let this winery write a `CANCELED` row naming itself. Returns the origin, or
 * `undefined` for a claim that is not this winery's to withdraw, or no longer
 * on notice.
 */
export const withdrawClaim = async (tx: DbTransaction, id: string): Promise<string | undefined> => {
  const rows = await tx.execute(sql`
    UPDATE domain_claims
    SET status = 'CANCELED', settled_at = now()
    WHERE id = ${id}::uuid
      AND incumbent_tenant_id = nullif(current_setting('app.tenant_id', true), '')::uuid
      AND status = 'NOTICE'
    RETURNING origin
  `);

  return ([...rows][0] as { origin?: string } | undefined)?.origin;
};
