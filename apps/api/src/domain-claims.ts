import {
  audit,
  capFor,
  capMessage,
  CLAIM_ALREADY_YOURS,
  CLAIM_NOTICE_HOURS,
  CLAIM_NOTICED,
  CLAIM_RACED,
  CLAIM_TRANSFERRED,
  CLAIM_WITHDRAWN,
  claimVerifyLimitKey,
  ConflictError,
  dnsRefusalMessage,
  getRequestActor,
  InvalidRequestError,
  isOurFault,
  isShopifyStoreDomain,
  NotFoundError,
  RateLimitedError,
  refusalMessage,
  SHOPIFY_UNVERIFIABLE,
  verificationToken,
  VERIFY_ATTEMPTS,
  VERIFY_WINDOW_SEC,
} from '@catalogorosso/core';
import type {
  ClaimWithdrawnResponse,
  Domain,
  DomainClaim,
  DomainClaimCheckedResponse,
  DomainClaimOpenedResponse,
  ServedClaimsResponse,
} from '@catalogorosso/api-client';
import {
  ClaimRacedError,
  countDomains,
  insertClaim,
  markClaimProven,
  readClaimById,
  readDomainByOrigin,
  readServedClaims,
  readDomainsFor,
  readTenantPlan,
  reissueClaimVerification,
  settleDomainClaim,
  withdrawClaim,
  withTenant,
  type ClaimSettlement,
  type DomainClaimRow,
  type DomainRow,
} from '@catalogorosso/db';
import { normalizeOrigin, type PlanTier, type RateLimiter } from '@catalogorosso/security';
import { publicResolveTxt, verifyDnsToken, type ResolveTxt } from '@catalogorosso/security/net';

/**
 * Claiming a domain another winery holds (P4-18, ADR 0028).
 *
 * **What this replaces is a dead end.** P4-01 answers an origin somebody else
 * holds with "not available", and until now that was the end of it: a winery
 * that churned, a business that was sold, an agency rebuilding a site under a
 * new workspace — each left the new owner unable to onboard at all.
 *
 * **The proof is the one a first verification takes**, a `_somm-verify` TXT
 * record on the registrable domain, so accepting it here is consistent rather
 * than a weakening. DNS only: a file on the storefront proves control of a web
 * server, and the web server is exactly what a contractor or an agency may
 * still have when the zone has already moved on.
 *
 * **What happens next depends on the holder**, and the claimant is never told
 * who that is. An abandoned, unpaid or never-verified holding moves at once. A
 * paying holder is put on 72 hours' notice first, because transferring a live
 * customer's origin on one DNS check is how a hostile contractor or a
 * compromised registrar kills a widget without anybody being told.
 */

export interface ClaimDomainCommand {
  readonly tenantId: string;
  /** Whatever the seller typed. Normalised here, as an added domain is. */
  readonly input: string;
}

export interface VerifyClaimCommand {
  readonly tenantId: string;
  readonly claimId: string;
}

/**
 * What the claim methods need. The domains port's own dependencies are a
 * superset, and it passes them straight through: one limiter, one resolver
 * factory, one clock for both halves of the domains screen.
 */
export interface DomainClaimsDeps {
  readonly audit?: typeof audit;
  readonly environment?: 'production' | 'development' | undefined;
  readonly newToken?: () => string;
  readonly now?: () => number;
  readonly limiter?: RateLimiter | undefined;
  readonly newResolver?: () => ResolveTxt;
  /** Injected so a test can decide a settlement's outcome without two wineries. */
  readonly settle?: typeof settleDomainClaim;
}

export interface WithdrawClaimCommand {
  /** The holder: the winery the claim was served on. */
  readonly tenantId: string;
  readonly claimId: string;
}

export interface DomainClaimsPort {
  claim(command: ClaimDomainCommand): Promise<DomainClaimOpenedResponse>;
  verifyClaim(command: VerifyClaimCommand): Promise<DomainClaimCheckedResponse>;
  /** The notices served on this winery that are still running (P4-18b). */
  servedClaims(tenantId: string): Promise<ServedClaimsResponse>;
  /** The holder keeps its origin (P4-18b). */
  withdrawClaim(command: WithdrawClaimCommand): Promise<ClaimWithdrawnResponse>;
}

/** The wire shape: JSON has no `Date`, and the holder is never in it. */
const toClaim = (row: DomainClaimRow): DomainClaim => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrableDomain,
  status: row.status,
  verificationToken: row.verificationToken,
  verificationExpiresAt: row.verificationExpiresAt?.toISOString() ?? null,
  transferAt: row.transferAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

const toDomain = (row: DomainRow): Domain => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrableDomain,
  status: row.status,
  kind: row.kind,
  verificationToken: row.verificationToken,
  verificationExpiresAt: row.verificationExpiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

/** How a claim that did not settle just now is described, from what it says about itself. */
const standing = (row: DomainClaimRow): DomainClaimCheckedResponse => {
  if (row.status === 'TRANSFERRED') {
    return {
      claim: toClaim(row),
      verified: true,
      transferred: true,
      reason: CLAIM_TRANSFERRED,
    };
  }

  if (row.status === 'CANCELED') {
    return { claim: toClaim(row), verified: true, transferred: false, reason: CLAIM_WITHDRAWN };
  }

  return {
    claim: toClaim(row),
    verified: row.status !== 'PENDING',
    transferred: false,
    ...(row.transferAt === null
      ? {}
      : { transferAt: row.transferAt.toISOString(), reason: CLAIM_NOTICED }),
  };
};

export const createDomainClaims = ({
  audit: record = audit,
  environment,
  newToken = verificationToken,
  limiter,
  newResolver = publicResolveTxt,
  now = Date.now,
  settle,
}: DomainClaimsDeps = {}): DomainClaimsPort => {
  /** The claim, re-read as it now stands. It is there: this winery just settled it. */
  const reread = async (tenantId: string, claimId: string): Promise<DomainClaimRow> => {
    const row = await withTenant(tenantId, (tx) => readClaimById(tx, claimId));

    if (row === undefined) throw new NotFoundError('No such claim.');

    return row;
  };

  /**
   * Moves the origin, or serves the notice, in the claim scope's own
   * transaction — never inside `withTenant`, which the scope refuses to nest
   * in (ADR 0028). The plan is read here, for the reason every tenant fact on
   * this path is: a value the caller supplied would be one it could choose.
   */
  const settleFor = async (
    tenantId: string,
    claimId: string,
  ): Promise<{
    readonly plan: PlanTier;
    readonly cap: number;
    readonly settled: ClaimSettlement;
  }> => {
    const plan: PlanTier = (await withTenant(tenantId, readTenantPlan)) ?? 'none';
    const cap = capFor(plan);
    const { userId, ip, userAgent } = getRequestActor();

    try {
      /* Resolved here rather than as a default, so a suite that never reaches a
       * claim does not need the settlement in its mock of the package. */
      const settled = await (settle ?? settleDomainClaim)({
        claimId,
        claimantTenantId: tenantId,
        cap,
        noticeHours: CLAIM_NOTICE_HOURS,
        actor: { userId, ip, userAgent },
      });

      return { plan, cap, settled };
    } catch (error) {
      /* Rolled back whole: nothing moved, and asking again is the answer. */
      if (error instanceof ClaimRacedError) throw new ConflictError(CLAIM_RACED);
      throw error;
    }
  };

  const answer = async (tenantId: string, claimId: string): Promise<DomainClaimCheckedResponse> => {
    const { plan, cap, settled } = await settleFor(tenantId, claimId);

    /*
     * **At the cap, the claim stays proven.** Nothing was taken from the
     * holder, and a seller who frees a slot can check again without
     * republishing anything.
     */
    if (settled.kind === 'at-cap') throw new ConflictError(capMessage(plan, cap));

    const row = await reread(tenantId, claimId);

    if (settled.kind === 'transferred') {
      return {
        claim: toClaim(row),
        verified: true,
        transferred: true,
        reason: CLAIM_TRANSFERRED,
        domain: toDomain(settled.domain),
      };
    }

    return standing(row);
  };

  return {
    async servedClaims(tenantId) {
      const served = await withTenant(tenantId, readServedClaims);

      return {
        claims: served.map((row) => ({
          id: row.id,
          origin: row.origin,
          transferAt: row.transferAt.toISOString(),
        })),
      };
    },

    async withdrawClaim(command) {
      /*
       * **One transaction: the withdrawal and the holder's audit row.** The
       * claimant hears through the claim sweep, which reads the claim's new
       * state; this request never writes into the claimant's winery.
       */
      const origin = await withTenant(command.tenantId, async (tx) => {
        const withdrawn = await withdrawClaim(tx, command.claimId);

        if (withdrawn !== undefined) {
          await record(tx, { action: 'domain.claim_withdrawn', target: withdrawn });
        }

        return withdrawn;
      });

      /*
       * A claim served on another winery, one this winery made itself, one no
       * longer on notice and one that never existed are all the same empty
       * result, and §3.5 wants the same answer for each.
       */
      if (origin === undefined) throw new NotFoundError('No such claim.');

      return { id: command.claimId, origin, withdrawn: true };
    },

    async claim(command) {
      const normalised = normalizeOrigin(command.input, { environment });

      if (!normalised.ok) throw new InvalidRequestError(refusalMessage(normalised.reason));

      /* A claim is proved by DNS, which Shopify's own zone can never carry (P4-19). */
      if (isShopifyStoreDomain(normalised.registrableDomain)) {
        throw new ConflictError(SHOPIFY_UNVERIFIABLE);
      }

      const outcome = await withTenant(command.tenantId, async (tx) => {
        /* A claim on an origin this winery holds would be a claim against itself. */
        if ((await readDomainByOrigin(tx, normalised.origin)) !== undefined) {
          return { refused: 'held' } as const;
        }

        /*
         * **The cap is checked here as a courtesy and enforced at settlement.**
         * Telling a seller at the start that the claim could never land is
         * better than telling them after they have published a record — but
         * the binding count is taken under the winery's lock when the origin
         * actually moves, which is the only moment it can be right.
         */
        const plan: PlanTier = (await readTenantPlan(tx)) ?? 'none';
        const cap = capFor(plan);
        const covered = (await readDomainsFor(tx, normalised.registrableDomain)).length > 0;

        if (!covered && (await countDomains(tx)) >= cap) {
          return { refused: 'at-cap', plan, cap } as const;
        }

        const opened = await insertClaim(tx, {
          origin: normalised.origin,
          registrableDomain: normalised.registrableDomain,
          verificationToken: newToken(),
        });

        if (opened.created) {
          await record(tx, {
            action: 'domain.claim_opened',
            target: normalised.origin,
            metadata: { registrableDomain: normalised.registrableDomain },
          });
        }

        return { refused: false, ...opened } as const;
      });

      if (outcome.refused === 'held') throw new ConflictError(CLAIM_ALREADY_YOURS);
      if (outcome.refused === 'at-cap')
        throw new ConflictError(capMessage(outcome.plan, outcome.cap));

      return { claim: toClaim(outcome.claim), created: outcome.created };
    },

    async verifyClaim(command) {
      /*
       * **Counted before the lookup**, on P4-02's reasoning: this makes an
       * outbound DNS query on demand, and a count taken after the query has
       * already spent what it exists to protect.
       */
      if (limiter !== undefined) {
        const allowance = await limiter.check([
          {
            key: claimVerifyLimitKey(command.claimId),
            limit: VERIFY_ATTEMPTS,
            windowSec: VERIFY_WINDOW_SEC,
          },
        ]);

        if (!allowance.allowed) {
          throw new RateLimitedError(
            'That claim has been checked several times in the last few minutes. ' +
              'DNS takes a while to propagate — wait a moment and try again.',
          );
        }
      }

      const claim = await withTenant(command.tenantId, (tx) => readClaimById(tx, command.claimId));

      /*
       * Another winery's id and one that never existed are the same empty
       * result, and §3.5 wants the same answer for both. That includes a claim
       * served *on* this winery: the holder sees it, and may not act on it here.
       */
      if (claim === undefined) throw new NotFoundError('No such claim.');

      /*
       * Settled, withdrawn, or on notice: say so, idempotently.
       *
       * **A notice is never settled from here**, even once it has run out. It
       * moves the origin away from a paying winery, and that is only safe once
       * the winery has actually been told — which is P4-18b's sweep, not the
       * claimant pressing a button. Settling here would make the claimant's
       * patience the only thing between a paying holder and its origin.
       */
      if (claim.status !== 'PENDING' && claim.status !== 'PROVEN') return standing(claim);

      /* Proven, and refused at the cap last time: nothing to look up, settle again. */
      if (claim.status === 'PROVEN') return answer(command.tenantId, command.claimId);

      const token = claim.verificationToken;

      if (token === null) {
        throw new ConflictError('That claim has no verification in progress. Open it again.');
      }

      /* A lapsed nonce is replaced, not extended (P4-04). */
      if (claim.verificationExpiresAt !== null && claim.verificationExpiresAt.getTime() <= now()) {
        const reissued = await withTenant(command.tenantId, async (tx) => {
          const fresh = await reissueClaimVerification(tx, claim.id, newToken());

          if (fresh !== undefined) {
            await record(tx, {
              action: 'domain.claim_verification_reissued',
              target: claim.origin,
              metadata: { reason: 'expired' },
            });
          }

          return fresh;
        });

        return {
          claim: toClaim(reissued ?? claim),
          verified: false,
          transferred: false,
          reason:
            'That verification value expired, so we have issued a new one. ' +
            'Replace the TXT record with the value below and check again.',
        };
      }

      const checked = await verifyDnsToken(claim.registrableDomain, token, newResolver());

      if (!checked.ok) {
        /*
         * **Audited, and on the claimant's side only.** A claim checked over
         * and over against a record that never appears is what an attempt to
         * take somebody's domain looks like; the holder hears nothing until a
         * claim is actually proven.
         */
        await withTenant(command.tenantId, (tx) =>
          record(tx, {
            action: isOurFault(checked.reason)
              ? 'domain.claim_verify_error'
              : 'domain.claim_verify_failed',
            target: claim.origin,
            metadata: { reason: checked.reason },
          }),
        );

        return {
          claim: toClaim(claim),
          verified: false,
          transferred: false,
          reason: dnsRefusalMessage(checked.reason),
        };
      }

      await withTenant(command.tenantId, async (tx) => {
        /* `undefined` is a second request proving it first, which is a success. */
        const proven = await markClaimProven(tx, claim.id, token);

        if (proven !== undefined) {
          await record(tx, { action: 'domain.claim_proven', target: claim.origin });
        }
      });

      return answer(command.tenantId, command.claimId);
    },
  };
};
