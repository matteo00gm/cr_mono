import {
  audit,
  capFor,
  capMessage,
  ConflictError,
  dnsRefusalMessage,
  InvalidRequestError,
  isOurFault,
  METHOD_COLUMN,
  NotFoundError,
  ORIGIN_UNAVAILABLE,
  RateLimitedError,
  refusalMessage,
  verificationToken,
  VERIFY_ATTEMPTS,
  siblingOrigin,
  verifyLimitKey,
  VERIFY_WINDOW_SEC,
  wellKnownRefusalMessage,
  type VerifyMethod,
} from '@catalogorosso/core';
import type { Domain, ProbedDomain } from '@catalogorosso/api-client';
import {
  insertDomain,
  insertVerifiedSibling,
  markDomainVerified,
  readDomainById,
  readDomainByOrigin,
  readDomainsFor,
  readTenantPlan,
  reissueVerification,
  withTenant,
  type DomainRow,
} from '@catalogorosso/db';
import { normalizeOrigin, type PlanTier, type RateLimiter } from '@catalogorosso/security';
import {
  probeOrigin,
  publicResolveTxt,
  verifyDnsToken,
  verifyWellKnownFile,
  type Fetcher,
  type ResolveTxt,
} from '@catalogorosso/security/net';

/**
 * The domains port (P4-01, §3.3).
 *
 * The composition root's job, on the same reasoning as `members.ts`: this is
 * the one place that knows both how a domain is stored and what a seller is
 * told when it is refused, and neither package should learn about the other.
 *
 * **What makes this row security work rather than CRUD** is the answer to an
 * origin somebody else already holds. It has to be a refusal that says nothing,
 * because the alternative — "that belongs to another winery" — turns this
 * endpoint into a way to enumerate who our customers are, one domain at a time.
 */

export interface AddDomainCommand {
  readonly tenantId: string;
  /** Whatever the seller typed. Normalised here, never trusted as given. */
  readonly input: string;
}

export interface AddDomainResult {
  readonly domain: Domain;
  readonly created: boolean;
}

export interface VerifyDomainCommand {
  readonly tenantId: string;
  readonly domainId: string;
  /** Which proof the seller is offering. Their choice, not ours (P4-03). */
  readonly method: VerifyMethod;
}

export interface VerifyDomainResult {
  readonly domain: Domain;
  readonly verified: boolean;
  /** Absent on success. What the seller is told, and where to look, when not. */
  readonly reason?: string | undefined;
  /** Every origin the verification enabled, each probed (P4-05). */
  readonly verifiedOrigins?: readonly ProbedDomain[] | undefined;
}

export interface DomainsPort {
  add(command: AddDomainCommand): Promise<AddDomainResult>;
  verify(command: VerifyDomainCommand): Promise<VerifyDomainResult>;
}

/**
 * A check's outcome, with the two proofs' differing shapes already resolved.
 *
 * **Normalised at the call site rather than cast afterwards.** The DNS and file
 * checks report different reason sets, and the branch that knows which proof
 * ran is the only place that can map one to a message without a cast — which is
 * also the only place that can be wrong about it and be caught.
 */
interface Checked {
  readonly ok: boolean;
  /** The code, for the log. */
  readonly reason?: string | undefined;
  /** The prose, for the seller. */
  readonly message?: string | undefined;
  /** Ours to retry rather than theirs to fix. */
  readonly ours: boolean;
  /** What our own defences declined to do. Never returned to a caller. */
  readonly detail?: string | undefined;
}

/** What the transaction decided, before it is turned into an answer. */
type Outcome =
  | { readonly refused: 'taken' }
  | { readonly refused: 'at-cap'; readonly plan: PlanTier; readonly cap: number }
  | { readonly refused: false; readonly domain: DomainRow; readonly created: boolean };

/** The wire shape: JSON has no `Date`. */
const toResponse = (row: DomainRow): Domain => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrableDomain,
  status: row.status,
  verificationToken: row.verificationToken,
  verificationExpiresAt: row.verificationExpiresAt?.toISOString() ?? null,
  createdAt: row.createdAt.toISOString(),
});

export interface DomainsDeps {
  /**
   * The audit writer (P0-53), injected for the reason `members.ts` gives: a
   * test that mocks `@catalogorosso/db` gets a second copy of the context
   * module, and injecting it is what makes the audit row assertable at all.
   */
  readonly audit?: typeof audit;
  /**
   * `development` admits `http:` and `localhost`, which a local run needs and a
   * deployed stage must never accept. Production is `normalizeOrigin`'s own
   * default, so forgetting to pass this gets the strict answer.
   */
  readonly environment?: 'production' | 'development' | undefined;
  /** Injected so a test can assert the stored nonce rather than re-deriving it. */
  readonly newToken?: () => string;
  /** Injected so a test can decide a nonce has lapsed without waiting a week. */
  readonly now?: () => number;
  /**
   * The outbound client for the file check (P4-03). Defaults to `guardedFetch`
   * inside `verifyWellKnownFile` — injected here only so a test can answer
   * without a network, never to substitute an unguarded one.
   */
  readonly fetcher?: Fetcher | undefined;
  /**
   * Counts verification attempts (P2-04). Absent means unlimited, which is
   * only ever right in a test — see the note on the check itself.
   */
  readonly limiter?: RateLimiter | undefined;
  /**
   * Builds the resolver for one check. A factory rather than an instance
   * because a `Resolver` holds a channel, and one shared across every
   * invocation on a warm container has no way to be reset after a failure.
   * Injected so a test can answer without a nameserver.
   */
  readonly newResolver?: () => ResolveTxt;
}

export const createDomainsPort = ({
  audit: record = audit,
  environment,
  newToken = verificationToken,
  limiter,
  newResolver = publicResolveTxt,
  now = Date.now,
  fetcher,
}: DomainsDeps = {}): DomainsPort => ({
  async add(command) {
    const normalised = normalizeOrigin(command.input, { environment });

    /*
     * Refused before a transaction is opened. There is nothing to audit yet —
     * the seller has not attempted anything against our data, they have mistyped
     * — and the typed reason is what turns this screen from "invalid domain"
     * into something a seller can act on.
     */
    if (!normalised.ok) throw new InvalidRequestError(refusalMessage(normalised.reason));

    /*
     * **The refusal is returned from the transaction, never thrown inside it**,
     * and that is not style. A throw rolls the transaction back, which would
     * roll back the audit row recording the refusal — the one entry we most
     * want, on the one path a caller is told nothing. It is the same reasoning
     * `MemberWriteOutcome` follows: what a refusal means is HTTP-shaped, and
     * this package has an HTTP layer to say it in.
     */
    const outcome = await withTenant(command.tenantId, async (tx): Promise<Outcome> => {
      /*
       * Their own row first. Adding an origin this winery already holds is the
       * seller asking to finish a job they started, not a conflict — and the
       * response carries the existing token, which is the thing they came back
       * for. Nothing is leaked by saying so: RLS means a row that comes back
       * here is theirs by construction.
       */
      const existing = await readDomainByOrigin(tx, normalised.origin);

      if (existing !== undefined) return { refused: false, domain: existing, created: false };

      /*
       * The plan is read here rather than passed in, for the reason every other
       * tenant fact on this path is: a value the caller supplied would be a
       * value the caller could choose (P0-48). `null` is a winery between
       * signup and checkout, and `capFor` gives it the entry allowance.
       */
      const plan: PlanTier = (await readTenantPlan(tx)) ?? 'none';
      const cap = capFor(plan);

      /*
       * The count and the insert are one statement sequence inside one
       * transaction, serialised on the winery's own row — see `insertDomain`.
       * Counting out here and inserting in there would be the race the lock
       * exists to close.
       */
      const attempt = await insertDomain(
        tx,
        {
          origin: normalised.origin,
          registrableDomain: normalised.registrableDomain,
          verificationToken: newToken(),
        },
        cap,
      );

      /*
       * **The attempt is audited whether or not it succeeded**, and the refused
       * case is the one worth having: somebody adding origins that belong to
       * other wineries is the signature of the enumeration this endpoint
       * refuses to help with, and the response deliberately tells them nothing.
       * The audit row is what makes that visible on our side.
       *
       * Written inside the same transaction as the insert (P0-53). The origin
       * is in `target` rather than `metadata`, so it survives the redaction
       * allowlist — it is what the row is about, not free-form detail.
       */
      await record(tx, {
        action: attempt.outcome === 'created' ? 'domain.added' : `domain.add_${attempt.outcome}`,
        target: normalised.origin,
        metadata: { registrableDomain: normalised.registrableDomain, plan },
      });

      if (attempt.outcome === 'created') {
        return { refused: false, domain: attempt.domain, created: true };
      }

      return attempt.outcome === 'taken' ? { refused: 'taken' } : { refused: 'at-cap', plan, cap };
    });

    /*
     * Both refusals are 409s and they say opposite amounts on purpose. A plan
     * cap is the seller's own state, so naming the plan and the number is what
     * lets them act; an origin somebody else holds is not their state at all,
     * and naming anything about it would be an oracle.
     */
    if (outcome.refused === 'taken') throw new ConflictError(ORIGIN_UNAVAILABLE);
    if (outcome.refused === 'at-cap') {
      throw new ConflictError(capMessage(outcome.plan, outcome.cap));
    }

    return { domain: toResponse(outcome.domain), created: outcome.created };
  },

  async verify(command) {
    /*
     * **Counted before the lookup, not after.** This endpoint makes an outbound
     * network call on demand, so an unlimited one is a way to drive DNS queries
     * from our address at somebody else's nameservers — and counting a request
     * that has already spent the resource protects nothing.
     *
     * Per domain rather than per tenant: a seller with two domains is
     * legitimately verifying both, and the thing worth bounding is how hard any
     * one of them is retried.
     */
    if (limiter !== undefined) {
      const allowance = await limiter.check([
        {
          key: verifyLimitKey(command.domainId),
          limit: VERIFY_ATTEMPTS,
          windowSec: VERIFY_WINDOW_SEC,
        },
      ]);

      if (!allowance.allowed) {
        throw new RateLimitedError(
          'That domain has been checked several times in the last few minutes. ' +
            'DNS takes a while to propagate — wait a moment and try again.',
        );
      }
    }

    /*
     * Read, look up, write: three steps that cannot be one transaction, because
     * the middle one is a network call and a transaction held open across it
     * would hold a connection for as long as somebody else's nameserver takes
     * to answer. The write re-checks `PENDING` in its own statement, so a second
     * verification arriving meanwhile loses harmlessly rather than racing.
     */
    const domain = await withTenant(command.tenantId, (tx) => readDomainById(tx, command.domainId));

    /*
     * 404 for another winery's id as well as for one that does not exist, and
     * they are the same answer because RLS makes them the same query result.
     * 403 would tell an attacker the id is real (§3.5).
     */
    if (domain === undefined) throw new NotFoundError('No such domain.');

    /* Already done. Idempotent rather than a conflict: the seller's intent is
     * satisfied, and a screen that errors on a second click is worse. */
    if (domain.status === 'VERIFIED') {
      return { domain: toResponse(domain), verified: true };
    }

    if (domain.verificationToken === null) {
      throw new ConflictError('That domain has no verification in progress. Add it again.');
    }

    /*
     * **A lapsed nonce is replaced, not extended** (P4-04). It has been sitting
     * in a public TXT record for a week, so anybody who looked has a copy —
     * extending the window would mean the thing that proves control is a thing
     * a passer-by can replay.
     *
     * The seller is told the value changed rather than that verification
     * failed: to them the record they published is still there, and "it does
     * not match" with no explanation is the version of this that generates a
     * support ticket.
     */
    if (domain.verificationExpiresAt !== null && domain.verificationExpiresAt.getTime() <= now()) {
      const reissued = await withTenant(command.tenantId, async (tx) => {
        const fresh = await reissueVerification(tx, domain.id, newToken());

        if (fresh !== undefined) {
          await record(tx, {
            action: 'domain.verification_reissued',
            target: domain.origin,
            metadata: { reason: 'expired' },
          });
        }

        return fresh;
      });

      return {
        domain: toResponse(reissued ?? domain),
        verified: false,
        reason:
          'That verification value expired, so we have issued a new one. ' +
          'Replace the TXT record with the value below and check again.',
      };
    }

    /*
     * **Which proof is the seller's choice, and only theirs.** DNS is not
     * always theirs to change — plenty of them would have to ask whoever built
     * the site — and a file on the storefront is. Offering one and not the
     * other is how a domain never gets verified at all.
     */
    let checked: Checked;

    if (command.method === 'dns') {
      const result = await verifyDnsToken(
        domain.registrableDomain,
        domain.verificationToken,
        newResolver(),
      );

      checked = result.ok
        ? { ok: true, ours: false }
        : {
            ok: false,
            reason: result.reason,
            message: dnsRefusalMessage(result.reason),
            ours: isOurFault(result.reason),
          };
    } else {
      const result = await verifyWellKnownFile(
        domain.registrableDomain,
        domain.verificationToken,
        ...(fetcher === undefined ? [] : ([fetcher] as const)),
      );

      checked = result.ok
        ? { ok: true, ours: false }
        : {
            ok: false,
            reason: result.reason,
            message: wellKnownRefusalMessage(result.reason),
            /* A refusal by our own agent is ours to look at, not the seller's. */
            ours: result.reason === 'unreachable',
            ...(result.detail === undefined ? {} : { detail: result.detail }),
          };
    }

    if (!checked.ok) {
      /*
       * **A failed check is still an attempt, and it is audited.** A domain
       * being checked repeatedly against a record that never appears is what a
       * contested claim looks like from our side (P4-18), and the response
       * tells the seller only what to do next.
       */
      /*
       * **The precise refusal is recorded and never returned.** For the file
       * check, `detail` carries what `guardedFetch` actually declined to do —
       * an address it would not connect to, a redirect it would not follow —
       * and a caller who could read that could map our network with it.
       */
      await withTenant(command.tenantId, (tx) =>
        record(tx, {
          action: checked.ours ? 'domain.verify_error' : 'domain.verify_failed',
          target: domain.origin,
          metadata: {
            reason: checked.reason,
            method: METHOD_COLUMN[command.method],
            ...(checked.detail === undefined ? {} : { detail: checked.detail }),
          },
        }),
      );

      return { domain: toResponse(domain), verified: false, reason: checked.message };
    }

    const { verified, held } = await withTenant(command.tenantId, async (tx) => {
      const updated = await markDomainVerified(tx, domain.id, METHOD_COLUMN[command.method]);

      if (updated !== undefined) {
        await record(tx, {
          action: 'domain.verified',
          target: domain.origin,
          metadata: { method: METHOD_COLUMN[command.method] },
        });
      }

      /*
       * **The `www` spelling comes free with the proof** (P4-05, §3.3). The
       * seller proved control of the *zone* — a TXT record at the apex, or a
       * file on the storefront — and `www` is inside it. Demanding a second
       * round for the spelling a browser might use is how somebody ends up with
       * a silently dead widget on half their traffic and nothing anywhere
       * saying why.
       *
       * It is created here, inside the same transaction as the verification it
       * comes from, so a failure leaves neither.
       */
      const sibling = siblingOrigin(domain.origin, domain.registrableDomain);

      if (sibling !== undefined) {
        const made = await insertVerifiedSibling(
          tx,
          { origin: sibling, registrableDomain: domain.registrableDomain },
          METHOD_COLUMN[command.method],
        );

        /*
         * `undefined` means the sibling is already somebody's — theirs, or
         * another winery's. It does not become theirs by being adjacent to
         * something they proved, and a refusal here is not an error.
         */
        if (made !== undefined) {
          await record(tx, {
            action: 'domain.sibling_added',
            target: sibling,
            metadata: { from: domain.origin },
          });
        }
      }

      return {
        verified: updated,
        held: await readDomainsFor(tx, domain.registrableDomain),
      };
    });

    /*
     * **Probed outside the transaction, and outside it deliberately.** Each
     * probe is a network round trip to a host somebody else controls, and a
     * transaction held open across two of them holds a connection for as long
     * as the slower one takes to answer.
     *
     * Through `guardedFetch` like every other outbound request (P4-03a): a
     * probe is an equally attacker-chosen host and gets no exemption.
     */
    const probed = await Promise.all(
      held
        .filter((row) => row.status === 'VERIFIED')
        .map(async (row) => ({
          domain: toResponse(row),
          responds: await probeOrigin(
            row.origin,
            ...(fetcher === undefined ? [] : ([fetcher] as const)),
          ),
        })),
    );

    /*
     * `verified === undefined` means another request got there between the read
     * and the write. That is a success, and reporting it as anything else would
     * make a double-click an error.
     */
    return {
      domain: toResponse(verified ?? { ...domain, status: 'VERIFIED' }),
      verified: true,
      verifiedOrigins: probed,
    };
  },
});

/**
 * The port when nothing has configured one.
 *
 * Refusing loudly is the only safe default: an absent port that silently
 * accepted would be a domains screen that appears to work and verifies nothing.
 */
export class DomainsPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No domains port was supplied to createApp, so a domain cannot be added. This is a ' +
        'wiring bug at the composition root, not a request problem.',
    );
    this.name = 'DomainsPortNotConfiguredError';
  }
}

export const unconfiguredDomains: DomainsPort = {
  add: () => Promise.reject(new DomainsPortNotConfiguredError()),
  verify: () => Promise.reject(new DomainsPortNotConfiguredError()),
};
