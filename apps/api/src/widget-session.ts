import { randomUUID } from 'node:crypto';

import type { WidgetSessionResponse } from '@catalogorosso/api-client';
import { UnavailableError } from '@catalogorosso/core';
import type { WidgetTokenKeys } from '@catalogorosso/security/tokens';

import type { WidgetTenant } from './env.js';
import { isServiceable } from './widget-config.js';

/**
 * Minting a widget session (P2-12, §3.2 layer 2, §3.4).
 *
 * **What makes a stolen `pk_` useless off its own site.** The token carries the
 * origin it was minted for, and every later call must come from that origin
 * (P2-13). Everything the token says is taken from what the guards established
 * on this request — the tenant and its status resolved uncached from Postgres,
 * the origin normalised and verified — and nothing is taken from the caller.
 */

/**
 * Who signed the token, checked by every verifier (P2-13).
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

/** What a switched-off winery's widget is told, never naming why (§1.3). */
export const WIDGET_UNAVAILABLE = 'This widget is not available right now.';

export interface MintRequest {
  /** The keyset, loaded once per container (P2-11). Called only for a tenant that may mint. */
  readonly loadKeys: () => Promise<WidgetTokenKeys>;
  readonly tenant: WidgetTenant;
  /** The normalised, verified origin CORS resolved the tenant from. */
  readonly origin: string;
  readonly now?: Date | undefined;
  /** Injected so a test can name the ids it expects. */
  readonly newId?: (() => string) | undefined;
}

export const mintWidgetSession = async ({
  loadKeys,
  tenant,
  origin,
  now = new Date(),
  newId = randomUUID,
}: MintRequest): Promise<WidgetSessionResponse> => {
  /*
   * Before the keys, so a switched-off winery is told so even on a stage whose
   * keyset is missing: the widget has a disabled state to render, and a wiring
   * error would put an error with a retry button in front of a lapsed seller.
   */
  if (!isServiceable(tenant.status)) throw new UnavailableError(WIDGET_UNAVAILABLE);

  const keys = await loadKeys();

  /*
   * `sid` and `jti` are separate draws. `sid` names the conversation and
   * outlives the token when a session continues (P2-12a); `jti` names this token
   * alone, so revoking one (P2-13) never ends a conversation that re-minted.
   */
  const token = await keys.sign(
    { tid: tenant.tenantId, sid: newId(), origin, plan: tenant.plan, jti: newId() },
    {
      issuer: WIDGET_TOKEN_ISSUER,
      audience: WIDGET_TOKEN_AUDIENCE,
      ttlSec: WIDGET_TOKEN_TTL_SEC,
      now,
    },
  );

  // The token's own `exp`, which is whole seconds from `now`.
  const expiresAtSec = Math.floor(now.getTime() / 1000) + WIDGET_TOKEN_TTL_SEC;

  return { token, expiresAt: new Date(expiresAtSec * 1000).toISOString() };
};
