import { UnauthenticatedError, UnavailableError } from '@catalogorosso/core';
import type { WidgetTokenKeys } from '@catalogorosso/security/tokens';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv, WidgetTenant } from '../env.js';
import { isServiceable, WIDGET_UNAVAILABLE } from '../widget-config.js';
import {
  bearerTokenOf,
  checkWidgetToken,
  WIDGET_TOKEN_REFUSED,
  type TokenRefusal,
  type TokenRevocationCheck,
} from '../widget-token.js';
import { logger } from './logger.js';

/**
 * The widget token verify middleware (P2-13, §3.4).
 *
 * **Mounted after CORS and before the tenant's limits**, on a route that needs a
 * session. CORS establishes the tenant and the origin the token must match; the
 * limits need the session id this sets. A preflight never gets here, because
 * CORS answers it, and that is right: a browser sends no `Authorization` on one.
 *
 * **Every token refusal is the same 401.** The reason goes to `onRejected`,
 * which can never fail the request, and from there to `security_events`
 * (P2-16). A switched-off winery is the exception, and deliberately: it is told
 * `unavailable` so its widget renders disabled rather than broken (P3-21), and a
 * tenant's status is no secret — config already says it.
 */

export interface RejectedWidgetToken {
  readonly reason: TokenRefusal;
  /** The tenant CORS resolved, which the token was presented to. */
  readonly tenantId: string;
  /** As CORS verified it. The token's own claim is not reported: a forged one is attacker-written. */
  readonly origin: string;
}

export interface WidgetAuthOptions {
  /** The keyset, loaded once per container (P2-11). */
  readonly loadKeys: () => Promise<WidgetTokenKeys>;
  /** `isTokenRevoked` (P2-12a). Required: a verifier that cannot ask has nothing to fail closed on. */
  readonly isRevoked: TokenRevocationCheck;
  /** Where refusals go; P2-16 supplies the `security_events` writer. */
  readonly onRejected?: ((event: RejectedWidgetToken) => Promise<void>) | undefined;
  /** Injected so expiry is testable without waiting. */
  readonly now?: (() => Date) | undefined;
}

/** A route that needs a session was mounted where CORS had not resolved a tenant: a wiring bug. */
export class WidgetTokenUnresolvedError extends Error {
  constructor() {
    super(
      'requireWidgetToken ran with no resolved widget tenant. It must be mounted after ' +
        'widgetCors, which establishes the tenant and the origin a token is checked against.',
    );
    this.name = 'WidgetTokenUnresolvedError';
  }
}

/** The default report: the reason and nothing else, as `widgetCors` reports its own (P0-56). */
const logRejection = (event: RejectedWidgetToken): Promise<void> => {
  logger.warn({ kind: 'widget_token_refused', type: event.reason }, 'a widget token was refused');
  return Promise.resolve();
};

/** Reports a refusal without ever letting the report affect the response. */
const report = (
  onRejected: (event: RejectedWidgetToken) => Promise<void>,
  event: RejectedWidgetToken,
): void => {
  const unrecorded = () => {
    logger.warn(
      { kind: 'widget_token_refusal_unrecorded', type: event.reason },
      'a token refusal went unrecorded',
    );
  };

  try {
    onRejected(event).catch(unrecorded);
  } catch {
    unrecorded();
  }
};

export const requireWidgetToken =
  ({
    loadKeys,
    isRevoked,
    onRejected = logRejection,
    now = () => new Date(),
  }: WidgetAuthOptions): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const tenant = c.get('widgetTenant') as WidgetTenant | undefined;
    if (tenant === undefined) throw new WidgetTokenUnresolvedError();

    // Read uncached by CORS on this very request, so a lapsed tenant is refused now, not at expiry.
    if (!isServiceable(tenant.status)) throw new UnavailableError(WIDGET_UNAVAILABLE);

    const origin = c.get('widgetOrigin');

    const check = await checkWidgetToken({
      keys: await loadKeys(),
      token: bearerTokenOf(c.req.header('authorization')),
      tenant,
      origin,
      isRevoked,
      now: now(),
    });

    if (!check.accepted) {
      report(onRejected, { reason: check.reason, tenantId: tenant.tenantId, origin });
      throw new UnauthenticatedError(WIDGET_TOKEN_REFUSED);
    }

    // The session a handler and the session limit read, only ever from a token that passed.
    c.set('widgetSessionId', check.claims.sid);

    await next();
  };
