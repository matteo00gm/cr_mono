import {
  ForbiddenError,
  InvalidRequestError,
  RateLimitedError,
  UnauthenticatedError,
} from '@catalogorosso/core';
import type { WidgetSessionResponse } from '@catalogorosso/api-client';
import type { SecretKeyTenant } from '@catalogorosso/db';
import { normalizeOrigin, type RateLimiter } from '@catalogorosso/security';
import { hashSecretKey, looksLikeSecretKey } from '@catalogorosso/security/api-keys';
import type { WidgetTokenKeys } from '@catalogorosso/security/tokens';
import { z } from 'zod';

import type { WidgetTenant } from './env.js';
import { bearerTokenOf, type TokenRevocationCheck } from './widget-token.js';
import { mintWidgetSession } from './widget-session.js';

/**
 * A session minted by the seller's own server (P4-10, §3.2 layer 3).
 *
 * **The only integration a page cannot spoof.** On the browser path the origin
 * is what the browser says it is, and a page can only ever be itself; here the
 * seller's backend presents its secret key and names the origin the session is
 * for, and we mint a token bound to that origin *if and only if* it is one the
 * winery has verified. The token then works from that origin and nowhere else.
 *
 * The order of the checks is the design, and every one of them refuses before
 * the next costs anything:
 *
 * 1. **No `Origin` header.** A browser sends one on every cross-origin POST, so
 *    a request carrying one is a secret key in browser code — a leak. Refused
 *    before the key is looked at, which also means the refusal says nothing
 *    about whether the key is real.
 * 2. **The shape of the key.** A `pk_`, an empty header, or anything else that
 *    cannot be one of our secrets costs no hash and no query.
 * 3. **The key itself**, found by its SHA-256 (ADR 0025) under the seventh RLS
 *    scope (ADR 0026). Unknown, revoked and rotated-away all answer the same.
 * 4. **The key's own rate limit**, once we know whose key it is.
 * 5. **The origin**, which must be one this winery has verified — exact
 *    equality after normalisation, never a pattern (§3.4).
 */

/** What the caller sends: the origin the session is for, and nothing else. */
export const serverSessionRequest = z.object({ origin: z.string().min(1).max(300) }).strict();

export const SERVER_SESSION_BODY_EXPECTED =
  'Send a JSON body with the origin the session is for, e.g. {"origin":"https://www.winery.com"}.';

/**
 * How many sessions one secret key may mint per minute.
 *
 * **Generous on purpose, because a real storefront mints one per page view**,
 * and the backend doing it is a single caller at a single address — so the
 * per-address widget limits (P2-04), which assume a visitor, would throttle a
 * busy shop into failing. What this bounds is a leaked key being used to mint in
 * a loop; what bounds the *cost* of that is the monthly plan cap (P2-36), which
 * every chat on every session still spends.
 */
export const SERVER_SESSIONS_PER_MINUTE = 600;

export const serverSessionLimitKey = (tenantId: string): string =>
  `widget:server-session:${tenantId}`;

/** Told to a caller whose request carried an `Origin`, i.e. a browser. */
export const SECRET_KEY_IN_BROWSER =
  'This endpoint is for your server, and a browser just called it. A secret key must never ' +
  'be in code a browser can read — if it has been, rotate it now in the dashboard.';

/** One answer for every key we will not accept, so none can be told apart. */
export const SECRET_KEY_REFUSED = 'That secret key is not valid.';

export interface ServerSessionRequest {
  /** The `Origin` header, which must be absent. */
  readonly originHeader: string | undefined;
  readonly authorization: string | undefined;
  readonly body: unknown;
}

export interface ServerSessionDeps {
  readonly resolve: (secretKeyHash: string) => Promise<SecretKeyTenant | undefined>;
  readonly limiter: RateLimiter;
  readonly loadKeys: () => Promise<WidgetTokenKeys>;
  readonly isRevoked: TokenRevocationCheck;
  /** The same environment the browser path normalises with, for the same reason. */
  readonly environment?: 'production' | 'development' | undefined;
}

export const mintServerSession = async (
  { originHeader, authorization, body }: ServerSessionRequest,
  { resolve, limiter, loadKeys, isRevoked, environment }: ServerSessionDeps,
): Promise<WidgetSessionResponse> => {
  if (originHeader !== undefined) throw new InvalidRequestError(SECRET_KEY_IN_BROWSER);

  const key = bearerTokenOf(authorization);

  if (key === undefined || !looksLikeSecretKey(key)) {
    throw new UnauthenticatedError(SECRET_KEY_REFUSED);
  }

  const tenant = await resolve(hashSecretKey(key));

  if (tenant === undefined) throw new UnauthenticatedError(SECRET_KEY_REFUSED);

  const allowance = await limiter.check([
    {
      key: serverSessionLimitKey(tenant.tenantId),
      limit: SERVER_SESSIONS_PER_MINUTE,
      windowSec: 60,
    },
  ]);

  if (!allowance.allowed) {
    throw new RateLimitedError('This secret key is minting sessions too quickly.');
  }

  const parsed = serverSessionRequest.safeParse(body);

  if (!parsed.success) throw new InvalidRequestError(SERVER_SESSION_BODY_EXPECTED);

  const normalised = normalizeOrigin(parsed.data.origin, { environment });

  /*
   * **Exact equality against the verified set, and the caller is told why.**
   * Unlike a refusal on the browser path, this is the seller asking about their
   * own winery with their own secret — naming the problem leaks nothing they
   * do not already hold, and a vague refusal here is an afternoon of debugging.
   */
  if (!normalised.ok || !tenant.verifiedOrigins.includes(normalised.origin)) {
    throw new ForbiddenError(
      'That origin is not one of your verified domains. A session can only be minted for an ' +
        'origin you have verified in the dashboard.',
    );
  }

  const widgetTenant: WidgetTenant = {
    tenantId: tenant.tenantId,
    plan: tenant.plan,
    status: tenant.status,
    locale: tenant.locale,
  };

  /*
   * The same mint the browser path uses, so the token is indistinguishable and
   * every later check — origin binding, revocation, the P4-06 cutoff — applies
   * to it unchanged. No previous token: a server starts a session, and a
   * continuation is the browser's to ask for.
   */
  return mintWidgetSession({
    loadKeys,
    tenant: widgetTenant,
    origin: normalised.origin,
    previous: undefined,
    isRevoked,
  });
};
