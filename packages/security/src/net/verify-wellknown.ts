import { timingSafeEqual } from 'node:crypto';

import {
  guardedFetch,
  GuardedFetchRefused,
  type GuardedFailure,
  type GuardedResponse,
} from './guarded-fetch.js';

/**
 * Proving control of a domain by serving a file (P4-03, §3.3).
 *
 * The alternative to DNS, and the one most sellers reach for: they already have
 * somewhere to put a file on their own storefront, and plenty of them cannot
 * edit a DNS zone without asking whoever built the site.
 *
 * **The fetch is three lines; the constraints are the substance, and they live
 * in `guardedFetch` (P4-03a).** This is a request our server makes to a host an
 * attacker chose, which is the textbook SSRF shape — so it goes through the
 * agent that validates the address at socket connect, refuses redirects, allows
 * only https on 443, caps the body, and times out.
 *
 * **The nonce is in the path, not only in the file.** A seller publishes
 * `/.well-known/somm-verify-<nonce>.txt`, so the URL is itself unguessable:
 * a host that serves the right bytes at a path nobody told them about has not
 * proved anything, and one that serves anything at all at this path has.
 */

/** Where a seller puts the file. The nonce is part of the name. */
export const wellKnownPath = (token: string): string => `/.well-known/somm-verify-${token}.txt`;

/** Why a domain was not verified this way. */
export type WellKnownFailure =
  /** Nothing at that path. The seller has not uploaded the file yet. */
  | 'not_found'
  /** Something was served and it is not the value we issued. */
  | 'mismatch'
  /** We could not reach the site, or refused to. Told to the seller as one thing. */
  | 'unreachable';

/**
 * A discriminated union, the same shape `verifyDnsToken` returns.
 *
 * `detail` is the precise refusal, **for our logs only**. `guardedFetch`'s
 * reasons name what our defences did — that a host resolved to a private
 * address, that a redirect was refused — and none of it belongs in an answer to
 * a caller. "We could not reach your site" is true and gives an attacker
 * nothing (P4-03a).
 */
export type WellKnownVerification =
  | { readonly ok: true }
  | {
      readonly ok: false;
      readonly reason: WellKnownFailure;
      readonly detail?: GuardedFailure | undefined;
    };

/** Injected so a test can answer without a network. */
export type Fetcher = typeof guardedFetch;

/**
 * The client every outbound request in this module reaches for.
 *
 * **One constant, so there is one thing to be right about.** Two defaults would
 * be two places to get it wrong, and the one that got it wrong would be the
 * quieter function — a probe that returns a boolean cannot report *why* it
 * failed, so an unguarded one would look identical to a guarded one from
 * outside. Sharing the binding means the case that proves `verifyWellKnownFile`
 * is guarded proves the probe is too.
 */
const DEFAULT_FETCHER: Fetcher = guardedFetch;

/**
 * Whether two strings are the same, without saying where they first differ.
 *
 * Constant-time for the reason `verify-dns.ts` gives, and equivalent to `===`
 * in behaviour by construction — the difference is timing, and the reason is
 * that `===` on a secret stops at the first differing byte.
 */
const sameSecret = (left: string, right: string): boolean => {
  const a = Buffer.from(left, 'utf8');
  const b = Buffer.from(right, 'utf8');

  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Whether the body is the nonce.
 *
 * **Trimmed, and that is not leniency.** `echo <nonce> > file` leaves a newline,
 * every editor adds one, and a verification that refused it would fail for the
 * most obvious way a seller creates this file. What is *not* tolerated is
 * anything else around the value — a quoted form or a `key=value` line is a
 * different file, and saying so is more useful than accepting a prefix.
 */
const bodyIsToken = (body: string, token: string): boolean => sameSecret(body.trim(), token);

const failureOf = (status: number): WellKnownFailure =>
  /*
   * **A 200 with the wrong body is a mismatch, not a missing file**, and the
   * distinction matters more here than it looks: plenty of storefronts answer
   * an unknown path with a styled 200 page rather than a 404, so "we found
   * something and it is not your value" is what a seller needs to hear.
   */
  status === 404 || status === 410 ? 'not_found' : 'mismatch';

export const verifyWellKnownFile = async (
  registrableDomain: string,
  token: string,
  fetcher: Fetcher = DEFAULT_FETCHER,
): Promise<WellKnownVerification> => {
  let response: GuardedResponse;

  try {
    response = await fetcher(`https://${registrableDomain}${wellKnownPath(token)}`);
  } catch (error) {
    /*
     * Every refusal collapses to one thing on the way out, and the precise
     * reason goes to `detail` for our own logs. A caller that could tell
     * `blocked_address` from `timeout` could use this endpoint to map which
     * addresses our network refuses to reach.
     */
    return {
      ok: false,
      reason: 'unreachable',
      detail: error instanceof GuardedFetchRefused ? error.reason : 'network',
    };
  }

  if (response.status !== 200) return { ok: false, reason: failureOf(response.status) };

  return bodyIsToken(response.body, token) ? { ok: true } : { ok: false, reason: 'mismatch' };
};

/**
 * Whether a host answers at all (P4-05, §3.3).
 *
 * **Through the same guarded agent, and that is the point of it being here.** A
 * liveness probe is a request to a host somebody else chose, exactly like the
 * file check — so it gets the same address validation at socket connect, the
 * same refusal to follow a redirect, the same ports and scheme. A "just a quick
 * HEAD" helper written beside this one would be the hole.
 *
 * **Any answer counts, including a 404.** The question is whether a widget
 * loaded on that origin would reach a live host, not whether the root path
 * happens to be a page — plenty of storefronts answer `/` with a redirect or a
 * 403 and serve everything else perfectly.
 */
export const probeOrigin = async (
  origin: string,
  fetcher: Fetcher = DEFAULT_FETCHER,
): Promise<boolean> => {
  try {
    await fetcher(`${origin}/`, { method: 'HEAD' });

    return true;
  } catch {
    /*
     * Swallowed, and the swallow is the contract. A probe is advice on a screen
     * — "www.winery.com does not respond, remove it?" — and a host that is down
     * for the minute somebody happens to press verify must not fail the
     * verification it is attached to.
     */
    return false;
  }
};
