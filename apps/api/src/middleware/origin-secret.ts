import { timingSafeEqual } from 'node:crypto';
import type { MiddlewareHandler } from 'hono';

import { NotFoundError } from '@catalogorosso/core';

/**
 * Refuses requests that did not arrive through CloudFront (A2).
 *
 * **Why a header and not an Origin Access Control.** OAC was the first choice,
 * built and deployed: it locks the origin correctly for GET — a direct call
 * returned 403 while the same request through the distribution returned 200 —
 * and it breaks **every POST**, because CloudFront does not sign the request
 * body for a Lambda origin, so an `AWS_IAM` Function URL rejects anything that
 * has one. The two alternatives are worse here: `oac` requires the *client* to
 * compute `x-amz-content-sha256`, which a widget embedded on a seller's site
 * cannot do, and `oac-with-edge-signing` puts Lambda@Edge on every request.
 *
 * **What this gives up, stated plainly.** A shared secret is a bearer token,
 * not a signature. Anyone who can read the distribution's configuration can
 * replay it, so this defends against the internet rather than against an
 * insider with console access. That is the smaller half of the problem and by
 * far the more likely one: today the Function URL is reachable by anyone who
 * has the string, and the URL appears in CloudFront's own origin config, in
 * `infra/cdn.ts`, and in any error a client is shown.
 *
 * The value never leaves AWS. CloudFront attaches it at the *origin-request*
 * stage, after the viewer request is done being anything the caller controls —
 * a viewer cannot see it, and a viewer-supplied header of the same name is
 * replaced rather than merged.
 */

/** The header CloudFront attaches. Lowercase: Hono normalises on lookup. */
export const ORIGIN_SECRET_HEADER = 'x-origin-secret';

/**
 * Constant-time comparison, which matters more here than it looks.
 *
 * A direct caller can retry against the Function URL as fast as they like with
 * no rate limit in front of them — that is the whole reason this middleware
 * exists — so a byte-by-byte `===` is a genuinely reachable oracle rather than
 * a theoretical one. `timingSafeEqual` throws on a length mismatch, so the
 * lengths are compared first and separately.
 */
const matches = (provided: string, expected: string): boolean => {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);

  return a.length === b.length && timingSafeEqual(a, b);
};

/**
 * Answers **404**, not 403.
 *
 * The same reasoning as a cross-tenant id (§3.5): 403 confirms that something
 * is there and that the caller merely lacks the right header, which tells a
 * prober they have found the origin and should look for the secret. 404 says
 * nothing — and a caller who reaches this middleware is, by construction,
 * somebody who should not be talking to this host at all.
 */
export const requireOriginSecret = (expected: string): MiddlewareHandler => {
  if (expected.trim() === '') {
    /*
     * Refused at construction rather than treated as "no protection". An empty
     * secret would make every request match nothing and 404, or — if the check
     * were written the other way round — make every request pass. Both are
     * worse than failing to start, and E9 is the reason this is explicit: a
     * guard that silently becomes a no-op is the failure mode this repository
     * has already paid for once.
     */
    throw new Error(
      'requireOriginSecret: the expected secret is empty. Pass undefined to run ' +
        'without the guard (local development and tests), never an empty string.',
    );
  }

  return async (c, next) => {
    const provided = c.req.header(ORIGIN_SECRET_HEADER);

    if (provided === undefined || !matches(provided, expected)) {
      throw new NotFoundError('Not found.');
    }

    await next();
  };
};
