import { Resolver } from 'node:dns/promises';
import { timingSafeEqual } from 'node:crypto';

/**
 * Proving control of a domain through DNS (P4-02, §3.3).
 *
 * **The resolver is pinned, and that is the security property.** Node's default
 * resolver is whatever the host was handed — in a VPC, that is the VPC's, which
 * answers for internal names and is configurable by anybody who can reach the
 * DHCP options or the Route 53 private zone. A verification that trusts it is a
 * verification an attacker with that reach can forge for any domain they like,
 * and the forged answer looks identical to a real one.
 *
 * So this asks public nameservers directly. It is the one place in the product
 * where "whatever the network says" is not good enough, because the answer is
 * what grants a widget key permission to run on somebody's storefront.
 *
 * **The comparison is constant-time.** The nonce is 32 bytes of CSPRNG output
 * and is published in DNS, so timing is not the strongest attack against it —
 * but a verification endpoint that leaks a prefix a character at a time is a
 * verification endpoint somebody will eventually walk, and the fix costs one
 * import.
 */

/** The label a seller publishes the nonce under: `_somm-verify.winery.com`. */
export const VERIFY_LABEL = '_somm-verify';

/**
 * Cloudflare and Google, in that order.
 *
 * Two, because one resolver is a single point of failure for every
 * verification in the product, and Node falls through to the second when the
 * first does not answer. Both are anycast, neither is ours, and neither can be
 * reconfigured by anybody who has got inside our network — which is the whole
 * reason they are here rather than the default.
 */
export const PUBLIC_RESOLVERS: readonly string[] = ['1.1.1.1', '8.8.8.8'];

/** Why a domain was not verified. */
export type DnsFailure =
  /** Nothing at that name. The seller has not published the record yet. */
  | 'no_record'
  /** Records exist and none of them is the nonce we issued. */
  | 'mismatch'
  /** The lookup failed. Ours to retry, not the seller's to fix. */
  | 'resolver_error';

export type DnsVerification =
  { readonly ok: true } | { readonly ok: false; readonly reason: DnsFailure };

/** Injected so a test can answer without a network. */
export type ResolveTxt = (hostname: string) => Promise<string[][]>;

/**
 * A resolver that asks public nameservers, never the host's own.
 *
 * Built per call rather than once at module load: a `Resolver` holds a channel,
 * and a module-level one would be shared across every Lambda invocation on a
 * warm container with no way to reset it after a failure.
 */
export const publicResolveTxt = (): ResolveTxt => {
  const resolver = new Resolver();

  resolver.setServers([...PUBLIC_RESOLVERS]);

  return (hostname) => resolver.resolveTxt(hostname);
};

/**
 * Whether two strings are the same, without saying where they first differ.
 *
 * `timingSafeEqual` throws on a length mismatch, so the lengths are compared
 * first — and that leaks nothing, because a nonce's length is fixed and public.
 *
 * **No test can tell this from `left === right`, and none tries.** The
 * difference is timing, not behaviour, so a mutation that swaps one for the
 * other survives by construction — the mutant is equivalent and is recorded as
 * such rather than chased. What keeps this right is the line itself and the
 * reason beside it: `===` on a secret compares byte by byte and stops at the
 * first difference, which is a prefix oracle for anyone patient enough.
 */
const sameSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * The errors that mean "the seller has not published it yet" rather than
 * "something went wrong at our end".
 *
 * The distinction decides what a seller is told and whether we retry, and
 * conflating them produces the worst version of this screen: a seller reading
 * "not found" while our resolver is the thing that is broken.
 */
const ABSENT = new Set(['ENOTFOUND', 'ENODATA', 'NXDOMAIN']);

const codeOf = (error: unknown): string =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : '';

/**
 * Looks for the nonce in the domain's TXT records.
 *
 * **Every record is checked, not the first.** A domain's TXT records at one
 * name are a set — SPF, other vendors' verifications, an older nonce of ours —
 * and a check that read only `records[0]` would fail for every seller who
 * already verifies with anybody else.
 */
export const verifyDnsToken = async (
  registrableDomain: string,
  token: string,
  resolveTxt: ResolveTxt = publicResolveTxt(),
): Promise<DnsVerification> => {
  let records: string[][];

  try {
    records = await resolveTxt(`${VERIFY_LABEL}.${registrableDomain}`);
  } catch (error) {
    return { ok: false, reason: ABSENT.has(codeOf(error)) ? 'no_record' : 'resolver_error' };
  }

  if (records.length === 0) return { ok: false, reason: 'no_record' };

  /*
   * A TXT record longer than 255 characters arrives as several chunks, which
   * the protocol says to concatenate. A 64-character nonce never is one — but
   * joining costs nothing and a record that a seller pasted with a wrapper
   * around it should still be read the way every other resolver reads it.
   */
  const values = records.map((chunks) => chunks.join(''));

  return values.some((value) => sameSecret(value, token))
    ? { ok: true }
    : { ok: false, reason: 'mismatch' };
};
