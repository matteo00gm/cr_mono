import {
  audit,
  ConflictError,
  InvalidRequestError,
  ORIGIN_UNAVAILABLE,
  refusalMessage,
  verificationToken,
} from '@catalogorosso/core';
import type { Domain } from '@catalogorosso/api-client';
import { insertDomain, readDomainByOrigin, withTenant, type DomainRow } from '@catalogorosso/db';
import { normalizeOrigin } from '@catalogorosso/security';

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

export interface DomainsPort {
  add(command: AddDomainCommand): Promise<AddDomainResult>;
}

/** What the transaction decided, before it is turned into an answer. */
type Outcome =
  | { readonly taken: true }
  | { readonly taken: false; readonly domain: DomainRow; readonly created: boolean };

/** The wire shape: JSON has no `Date`. */
const toResponse = (row: DomainRow): Domain => ({
  id: row.id,
  origin: row.origin,
  registrableDomain: row.registrableDomain,
  status: row.status,
  verificationToken: row.verificationToken,
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
}

export const createDomainsPort = ({
  audit: record = audit,
  environment,
  newToken = verificationToken,
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

      if (existing !== undefined) return { taken: false, domain: existing, created: false };

      const created = await insertDomain(tx, {
        origin: normalised.origin,
        registrableDomain: normalised.registrableDomain,
        verificationToken: newToken(),
      });

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
        action: created === undefined ? 'domain.add_refused' : 'domain.added',
        target: normalised.origin,
        metadata: { registrableDomain: normalised.registrableDomain },
      });

      return created === undefined
        ? { taken: true }
        : { taken: false, domain: created, created: true };
    });

    if (outcome.taken) throw new ConflictError(ORIGIN_UNAVAILABLE);

    return { domain: toResponse(outcome.domain), created: outcome.created };
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
};
