/**
 * Outbound HTTP to a host somebody else chose (P4-03a, §3.3).
 *
 * **A subpath rather than the package barrel, on purpose.** This reaches for
 * `node:https` and `node:dns`, and the barrel is bundled into the dashboard —
 * a browser build that resolves `node:dns` fails, and the failure would arrive
 * in whichever PR next touched the dashboard rather than this one.
 */
export {
  guardedFetch,
  guardedLookup,
  GuardedFetchRefused,
  GUARDED_TIMEOUT_MS,
  MAX_BODY_BYTES,
  type GuardedFailure,
  type GuardedFetchOptions,
  type GuardedResponse,
  type LookupFn,
  type ResolveAll,
} from './guarded-fetch.js';
export { isPublicUnicast, mappedIpv4 } from './addresses.js';
export {
  publicResolveTxt,
  verifyDnsToken,
  PUBLIC_RESOLVERS,
  VERIFY_LABEL,
  type DnsFailure,
  type DnsVerification,
  type ResolveTxt,
} from './verify-dns.js';
export {
  verifyWellKnownFile,
  wellKnownPath,
  type Fetcher,
  type WellKnownFailure,
  type WellKnownVerification,
} from './verify-wellknown.js';
