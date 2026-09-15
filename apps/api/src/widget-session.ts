import { randomUUID } from 'node:crypto';

import type { WidgetSessionResponse } from '@catalogorosso/api-client';
import { UnauthenticatedError, UnavailableError } from '@catalogorosso/core';
import type { WidgetTokenKeys } from '@catalogorosso/security/tokens';

import type { WidgetTenant } from './env.js';
import { isServiceable, WIDGET_UNAVAILABLE } from './widget-config.js';
import {
  checkWidgetToken,
  WIDGET_TOKEN_AUDIENCE,
  WIDGET_TOKEN_ISSUER,
  WIDGET_TOKEN_REFUSED,
  WIDGET_TOKEN_TTL_SEC,
  type TokenRefusal,
  type TokenRevocationCheck,
} from './widget-token.js';

/**
 * Minting a widget session (P2-12, §3.2 layer 2, §3.4).
 *
 * **What makes a stolen `pk_` useless off its own site.** The token carries the
 * origin it was minted for, and every later call must come from that origin
 * (P2-13). Everything the token says is taken from what the guards established
 * on this request — the tenant and its status resolved uncached from Postgres,
 * the origin normalised and verified — and nothing is taken from the caller.
 *
 * **Continuing a session (P2-12a)** is the one exception to "nothing from the
 * caller", and it is bounded: the session id is read from a token this service
 * signed for this tenant and this origin, never from anything the caller wrote.
 */

/**
 * How long after its expiry a token may still continue its session (P2-12a).
 *
 * A shopper who compares tabs for twenty minutes and comes back with a
 * follow-up holds an expired token and a live purchase intent. Half an hour
 * covers that without turning an old token into a standing credential.
 */
export const WIDGET_SESSION_CONTINUATION_SEC = 30 * 60;

/**
 * How long one conversation may be continued in all, from its first token (P2-12a).
 *
 * Without it a session renews forever, each token inside the window of the one
 * before, and a stolen token never lapses.
 */
export const WIDGET_SESSION_MAX_LIFETIME_SEC = 4 * 60 * 60;

export interface MintRequest {
  /** The keyset, loaded once per container (P2-11). Called only for a tenant that may mint. */
  readonly loadKeys: () => Promise<WidgetTokenKeys>;
  readonly tenant: WidgetTenant;
  /** The normalised, verified origin CORS resolved the tenant from. */
  readonly origin: string;
  /** The token a returning widget presented to continue its session. Absent for a new visitor. */
  readonly previous?: string | undefined;
  /**
   * Asked before a session continues. Absent, a previous token is ignored and
   * the session starts afresh: continuing without asking could revive a revoked
   * token's conversation.
   */
  readonly isRevoked?: TokenRevocationCheck | undefined;
  readonly now?: Date | undefined;
  /** Injected so a test can name the ids it expects. */
  readonly newId?: (() => string) | undefined;
}

/** The part of a session that outlives its token. */
interface ContinuedSession {
  readonly sid: string;
  /** When the session's first token was minted, in seconds: the `iat_original` claim. */
  readonly startedAtSec: number;
}

/**
 * The refusals that are a replay rather than a lapse (P2-12a).
 *
 * A token we signed, presented from another site or for another tenant, or
 * revoked. Starting afresh from one of these would hide it; every other refusal
 * — no usable token at all — is a visitor with nothing to continue.
 */
const REPLAYS: ReadonlySet<TokenRefusal> = new Set<TokenRefusal>([
  'origin_mismatch',
  'tenant_mismatch',
  'revoked',
]);

/**
 * The session a previous token continues, or none (P2-12a).
 *
 * **`sid` is never taken on trust.** It keys a conversation, so a caller able to
 * name one would inherit another visitor's history. It comes only out of a
 * token `checkWidgetToken` accepted, checked exactly as every other call's token
 * is (P2-13) except that it may have expired within the window.
 */
const continuedSession = async (
  keys: WidgetTokenKeys,
  previous: string,
  {
    tenant,
    origin,
    isRevoked,
    now,
  }: {
    readonly tenant: WidgetTenant;
    readonly origin: string;
    readonly isRevoked: TokenRevocationCheck;
    readonly now: Date;
  },
): Promise<ContinuedSession | undefined> => {
  const check = await checkWidgetToken({
    keys,
    token: previous,
    tenant,
    origin,
    isRevoked,
    now,
    expiredWithinSec: WIDGET_SESSION_CONTINUATION_SEC,
  });

  if (!check.accepted) {
    if (REPLAYS.has(check.reason)) throw new UnauthenticatedError(WIDGET_TOKEN_REFUSED);
    return undefined;
  }

  const { sid, startedAtSec } = check.claims;
  const ageSec = Math.floor(now.getTime() / 1000) - startedAtSec;

  return ageSec > WIDGET_SESSION_MAX_LIFETIME_SEC ? undefined : { sid, startedAtSec };
};

export const mintWidgetSession = async ({
  loadKeys,
  tenant,
  origin,
  previous,
  isRevoked,
  now = new Date(),
  newId = randomUUID,
}: MintRequest): Promise<WidgetSessionResponse> => {
  /*
   * Before the keys and before any previous token, so a switched-off winery is
   * told so even on a stage whose keyset is missing: the widget has a disabled
   * state to render, and a wiring error would put an error with a retry button
   * in front of a lapsed seller.
   */
  if (!isServiceable(tenant.status)) throw new UnavailableError(WIDGET_UNAVAILABLE);

  const keys = await loadKeys();

  const continued =
    previous === undefined || isRevoked === undefined
      ? undefined
      : await continuedSession(keys, previous, { tenant, origin, isRevoked, now });

  // Whole seconds, as the token's own `iat` and `exp` are.
  const issuedAtSec = Math.floor(now.getTime() / 1000);

  /*
   * `sid` and `jti` are separate draws. `sid` names the conversation and
   * outlives the token when a session continues; `jti` names this token alone,
   * so revoking one (P2-13) never ends a conversation that re-minted.
   */
  const token = await keys.sign(
    {
      tid: tenant.tenantId,
      sid: continued?.sid ?? newId(),
      origin,
      plan: tenant.plan,
      jti: newId(),
      iat_original: continued?.startedAtSec ?? issuedAtSec,
    },
    {
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      ttlSec: WIDGET_TOKEN_TTL_SEC,
      now,
    },
  );

  return {
    token,
    expiresAt: new Date((issuedAtSec + WIDGET_TOKEN_TTL_SEC) * 1000).toISOString(),
  };
};
