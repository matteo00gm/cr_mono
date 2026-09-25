import type { WidgetTokenKeys } from '@catalogorosso/security/tokens';

import type { WidgetTenant } from './env.js';

/**
 * A widget session token, checked against the request it arrived on (P2-13, §3.4).
 *
 * **One check for both readers of a token**: the verify middleware in front of
 * every call that needs a session, and the mint deciding whether a session
 * continues (P2-12a). Two copies would drift into checking different things, and
 * the difference would be a way in. What each does with a refusal is its own:
 * the middleware refuses every one, and continuation starts afresh from a token
 * that is merely unusable while refusing one that is a replay.
 */

/**
 * Who signed the token, checked by every verifier.
 *
 * **A constant, not the API's public URL.** §3.4 names the claim and not its
 * value, and the obvious value, `AUTH_BASE_URL`, is an operator-set secret that
 * changes the day a custom domain exists. An issuer that moves invalidates every
 * live token at the moment it moves; one that never moves cannot.
 */
export const WIDGET_TOKEN_ISSUER = 'catalogorosso';

/** For the widget surface only; a dashboard token presented here fails on it (P2-15). */
export const WIDGET_TOKEN_AUDIENCE = 'widget';

/** Fifteen minutes (§3.4): short enough that expiry does most of revocation's work. */
export const WIDGET_TOKEN_TTL_SEC = 15 * 60;

/**
 * The one answer for a refused token, whatever the reason.
 *
 * A missing token, a forged one, another site's, another tenant's and a revoked
 * one read the same, so the answer says nothing about which sessions exist or
 * where they were minted. The reason is for `security_events` (P2-16).
 */
export const WIDGET_TOKEN_REFUSED = 'This session is no longer valid. Start a new one.';

/** Whether a token's `jti` was revoked — `isTokenRevoked` from `@catalogorosso/db`. */
export type TokenRevocationCheck = (tenantId: string, jti: string) => Promise<boolean>;

/**
 * When sessions on this origin ended, or nothing — `sessionCutoffAt` (P4-06).
 *
 * Optional on the check below, and the default is the strict one: absent means
 * *no cutoff is known*, not *there is no cutoff*. A verifier wired without it
 * would accept sessions a seller has revoked, which is the failure this whole
 * row exists to prevent — so a composition that forgets it is a wiring bug, and
 * the composition root supplies it unconditionally.
 */
export type SessionCutoffCheck = (tenantId: string, origin: string) => Promise<Date | undefined>;

/**
 * The token after `Bearer`, or nothing.
 *
 * Any other scheme, or none, reads as no token. P4-10's server-to-server
 * `sk_live_` key will arrive on this header too, and is told apart by its prefix
 * before this is read.
 */
export const bearerTokenOf = (header: string | undefined): string | undefined =>
  /^Bearer +(\S+) *$/i.exec(header ?? '')?.[1];

/** Why a token was not accepted. For logs and `security_events`, never for the caller. */
export type TokenRefusal =
  /** No token, or not a `Bearer` one. */
  | 'absent'
  /** It did not verify: not our key or algorithm, not our issuer or audience, or expired. */
  | 'invalid'
  /** Ours, and minted for another site — the replay §3.2 exists to stop. */
  | 'origin_mismatch'
  /** Ours, and minted for another tenant. */
  | 'tenant_mismatch'
  /** Ours, but without a claim every token we mint carries. */
  | 'malformed'
  /** Ours, bound to this site and tenant, and revoked. */
  | 'revoked'
  /**
   * Ours, and belonging to a session that ended when its origin was removed
   * (P4-06). Told apart from `revoked` because they are different events: one
   * is a token we named, the other is every session on a domain at once, and an
   * incident review reading `security_events` needs to know which.
   */
  | 'origin_removed';

/** What an accepted token says about its session. */
export interface SessionClaims {
  readonly sid: string;
  readonly jti: string;
  /** When the session's first token was minted, in seconds: the `iat_original` claim. */
  readonly startedAtSec: number;
}

export type TokenCheck =
  | { readonly accepted: true; readonly claims: SessionClaims }
  | { readonly accepted: false; readonly reason: TokenRefusal };

export interface TokenCheckRequest {
  readonly keys: WidgetTokenKeys;
  readonly token: string | undefined;
  /** The tenant CORS resolved on this request, uncached — never the token's own `tid`. */
  readonly tenant: WidgetTenant;
  /** The origin CORS normalised and verified on this request. */
  readonly origin: string;
  readonly isRevoked: TokenRevocationCheck;
  /** When sessions on this origin ended (P4-06). */
  readonly cutoffAt?: SessionCutoffCheck | undefined;
  readonly now?: Date | undefined;
  /** Continuation only (P2-12a): accept a token that expired less than this long ago. */
  readonly expiredWithinSec?: number | undefined;
}

const refused = (reason: TokenRefusal): TokenCheck => ({ accepted: false, reason });

/**
 * §3.4's checks, in order, failing closed.
 *
 * 1. **Signature, the `alg` allowlist, `iss`, `aud`, and `exp` and `iat` with
 *    the skew**: `keys.verify` (P2-11).
 * 2. **The token's origin is this request's verified origin** — the binding.
 * 3. **That origin is still verified for the token's tenant.** CORS resolved the
 *    tenant from `(pk_, Origin)` against verified domains on this very request,
 *    so a token passes only if its `tid` is that tenant; a domain removed after
 *    minting is refused by CORS before the token is read.
 * 4. **The `jti` is not revoked**, asked under the resolved tenant.
 * 5. **The session started after this origin's cutoff** (P4-06). Removing a
 *    domain ends every session on it at once, which no per-`jti` list could do:
 *    we never store the `jti`s we issue.
 *
 * The tenant still being active is the caller's to check first: a switched-off
 * winery is `unavailable`, not refused a token.
 */
export const checkWidgetToken = async ({
  keys,
  token,
  tenant,
  origin,
  isRevoked,
  cutoffAt,
  now,
  expiredWithinSec,
}: TokenCheckRequest): Promise<TokenCheck> => {
  if (token === undefined) return refused('absent');

  let claims: Record<string, unknown>;

  try {
    ({ payload: claims } = await keys.verify(token, {
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      now,
      expiredWithinSec,
    }));
  } catch {
    return refused('invalid');
  }

  if (claims.origin !== origin) return refused('origin_mismatch');
  if (claims.tid !== tenant.tenantId) return refused('tenant_mismatch');

  const { sid, jti, iat_original: startedAtSec } = claims;

  if (typeof sid !== 'string' || typeof jti !== 'string' || typeof startedAtSec !== 'number') {
    return refused('malformed');
  }

  if (await isRevoked(tenant.tenantId, jti)) return refused('revoked');

  /*
   * **Compared against `iat_original`, never `iat`** (P4-06). The current
   * token's own issue time moves every time a session refreshes (P3-21), so
   * comparing it would let a session outlive its revocation by doing the one
   * thing every live session does anyway.
   *
   * `>=` rather than `>`: a token minted in the same second as the removal is
   * on the wrong side of it. The cost of the strict comparison is one session
   * that has to start again; the cost of the loose one is a session that
   * survives a revocation.
   */
  const cutoff = await cutoffAt?.(tenant.tenantId, origin);

  if (cutoff !== undefined && startedAtSec * 1000 < cutoff.getTime()) {
    return refused('origin_removed');
  }

  return { accepted: true, claims: { sid, jti, startedAtSec } };
};
