import { randomBytes } from 'node:crypto';

import type { NormalizeFailure, PlanTier } from '@catalogorosso/security';
import type { DnsFailure, WellKnownFailure } from '@catalogorosso/security/net';

/**
 * What a seller is told when a domain is refused (P4-01, §3.3).
 *
 * **A `DomainError`'s message is the API contract and reaches the caller
 * verbatim** (P0-55), so these are written for the person adding a domain
 * rather than for us. Each one says what was wrong and what to do instead,
 * because "invalid domain" on the one screen a seller must get through before
 * the product works is a support ticket by design.
 *
 * The map is exhaustive over `NormalizeFailure` by type, so a reason added to
 * P2-05 fails the build here rather than falling through to a generic string —
 * which is the failure mode that produces "invalid domain" in the first place.
 */
const REFUSALS: Record<NormalizeFailure, string> = {
  invalid_url: 'That does not look like a domain. Enter it as winery.com or www.winery.com.',
  not_https:
    'Only https domains can be added. Your storefront has to be served over https before the widget can run on it.',
  ip_literal:
    'An IP address cannot be verified as a domain. Enter the hostname your storefront is served from.',
  public_suffix:
    'That is a domain suffix rather than a domain. Enter the full name, such as winery.com.',
  single_label: 'A domain needs a suffix. Enter winery.com rather than winery.',
  has_path:
    'Enter the domain on its own, with no path. The widget is allowed on every page of a domain you verify.',
  localhost: 'localhost cannot be verified. Add the domain your storefront is published on.',
};

export const refusalMessage = (reason: NormalizeFailure): string => REFUSALS[reason];

/**
 * What an origin somebody else already holds is answered with.
 *
 * **Generic on purpose, and the generality is the security property** (§3.2).
 * "That origin belongs to another tenant" confirms a competitor is a customer,
 * and repeated against a list of domains it enumerates our customer base. This
 * message is the same one an origin the seller has mistyped would get.
 */
export const ORIGIN_UNAVAILABLE =
  'That domain is not available to add. If it is yours and you are seeing this, contact support.';

/**
 * A verification nonce.
 *
 * 32 bytes from the CSPRNG, hex. It is published — in DNS or in a file at a
 * URL — so its only job is to be unguessable: a seller who could predict the
 * nonce another seller will be issued could stage the proof before the claim.
 *
 * Expiry and single use are P4-04's; this is the generator both halves share.
 */
export const verificationToken = (): string => randomBytes(32).toString('hex');

/**
 * How many domains a plan includes (P4-07).
 *
 * **Counted across `PENDING` and `VERIFIED` together**, because a pending claim
 * holds the origin against every other winery on the platform (§3.2) — so a cap
 * that ignored them would let a seller hold any number of origins simply by
 * never finishing the verification.
 *
 * `none` is a tenant that has not chosen a plan yet, which every tenant is
 * between signup and checkout. It gets the entry allowance rather than nought:
 * a seller who cannot add the one domain they came to add cannot try the
 * product at all, and this is the screen that gates everything else.
 */
export const DOMAIN_CAPS: Readonly<Record<PlanTier, number>> = {
  CANTINA: 1,
  ECOMMERCE: 2,
  none: 1,
};

/** What a seller calls their plan, which is not what the enum calls it. */
const PLAN_NAMES: Readonly<Record<PlanTier, string>> = {
  CANTINA: 'Cantina',
  ECOMMERCE: 'E-commerce',
  none: 'trial',
};

export const capFor = (plan: PlanTier): number => DOMAIN_CAPS[plan];

/**
 * What a seller at their cap is told.
 *
 * **Names the plan, the number, and where to change it.** A bare "limit
 * reached" on the screen that gates the whole product is a support ticket, and
 * a seller who cannot tell whether they are one domain short or on the wrong
 * plan has no way to act on it.
 */
export const capMessage = (plan: PlanTier, cap: number): string =>
  `Your ${PLAN_NAMES[plan]} plan includes ${String(cap)} ${cap === 1 ? 'domain' : 'domains'}, ` +
  'and they are all in use. Remove one you no longer serve, or change plan on the ' +
  'Fatturazione screen.';

/**
 * How often one domain may be re-checked (P4-02, P2-04).
 *
 * **This endpoint makes an outbound network call on demand**, which makes it an
 * amplification vector: without a limit, an owner with one domain can drive as
 * many DNS lookups from our address as they like, at somebody else's
 * nameservers.
 *
 * Ten in ten minutes is set against what a seller legitimately does. DNS
 * propagation is slow and uneven, so the honest behaviour is to publish the
 * record and press the button a few times over a quarter of an hour — and a
 * limit tight enough to catch that is a limit that teaches sellers the product
 * is broken.
 */
export const VERIFY_ATTEMPTS = 10;
export const VERIFY_WINDOW_SEC = 600;

/** The bucket a domain's verification attempts are counted in. */
export const verifyLimitKey = (domainId: string): string => `domain-verify:${domainId}`;

/**
 * What a seller is told when a domain did not verify.
 *
 * **"Not found" and "does not match" send them to different places**, and
 * giving the wrong one is how somebody spends an afternoon re-checking DNS they
 * already got right. The third is ours, not theirs, and says so.
 */
const DNS_REFUSALS: Readonly<Record<DnsFailure, string>> = {
  no_record:
    'We could not find the TXT record. DNS can take a few minutes to propagate — publish it, then try again.',
  mismatch:
    'We found a TXT record at that name, but it is not the value we issued. Copy the value below exactly, with no quotes around it.',
  resolver_error:
    'We could not complete the DNS lookup. That is a problem at our end rather than with your record — try again in a moment.',
};

export const dnsRefusalMessage = (reason: DnsFailure): string => DNS_REFUSALS[reason];

/** A failed check is worth retrying by the seller; ours is worth retrying by us. */
export const isOurFault = (reason: DnsFailure): boolean => reason === 'resolver_error';

/**
 * What a seller is told when the file check did not pass (P4-03).
 *
 * **`unreachable` is one message for eight different refusals**, and the
 * flattening is deliberate: `guardedFetch`'s reasons name what our network
 * declined to do — an address it would not connect to, a redirect it would not
 * follow — and a caller who could read them could use this endpoint to map our
 * defences. The precise reason goes to the audit log instead.
 */
const WELL_KNOWN_REFUSALS: Readonly<Record<WellKnownFailure, string>> = {
  not_found:
    'We could not find the file. Upload it to that exact path on your storefront, then try again.',
  mismatch:
    'Something answered at that path and it is not the value we issued. The file must contain the value below and nothing else — many storefronts serve a themed page instead of a 404, which looks like this.',
  unreachable:
    'We could not reach your site to check. Make sure it is served over https on the standard port and try again.',
};

export const wellKnownRefusalMessage = (reason: WellKnownFailure): string =>
  WELL_KNOWN_REFUSALS[reason];

/** The two proofs a seller may offer, as the API names them. */
export const VERIFY_METHODS = ['dns', 'wellknown'] as const;
export type VerifyMethod = (typeof VERIFY_METHODS)[number];

/** How the choice is recorded on the row. */
export const METHOD_COLUMN: Readonly<Record<VerifyMethod, 'DNS_TXT' | 'WELL_KNOWN'>> = {
  dns: 'DNS_TXT',
  wellknown: 'WELL_KNOWN',
};

/**
 * The other spelling of an origin — apex to `www`, or `www` back to apex
 * (P4-05, §3.3).
 *
 * **The `www` mismatch is otherwise the most common support ticket there is**,
 * and it presents as "the widget doesn't work" with nothing visible anywhere to
 * explain it: the seller verified `winery.com`, their storefront redirects to
 * `www.winery.com`, and the browser sends an `Origin` the allowlist has never
 * heard of.
 *
 * `undefined` when there is no sibling to make. `shop.winery.com` is not an
 * apex and `www.shop.winery.com` is not a spelling of it — both are ordinary
 * subdomains that a seller adds deliberately, and inventing a `www` for every
 * one of them would expand an allowlist nobody asked to expand.
 */
export const siblingOrigin = (origin: string, registrableDomain: string): string | undefined => {
  let url: URL;

  try {
    url = new URL(origin);
  } catch {
    return undefined;
  }

  /* Scheme and port carry over: `http://winery.com:3000` and its `www` are the
   * same pair, and a sibling on a different port would be a different origin. */
  const suffix = url.port === '' ? '' : `:${url.port}`;
  const at = (host: string): string => `${url.protocol}//${host}${suffix}`;

  if (url.hostname === registrableDomain) return at(`www.${registrableDomain}`);
  if (url.hostname === `www.${registrableDomain}`) return at(registrableDomain);

  return undefined;
};
