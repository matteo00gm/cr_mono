import { MfaRequiredError, StepUpRequiredError, UnauthenticatedError } from '@catalogorosso/core';
import type { MiddlewareHandler } from 'hono';

import type { AppEnv } from '../env.js';
import type { AuthPort } from './auth.js';

/**
 * Fresh verification for a sensitive action (P4-11).
 *
 * **Reads the session row, never the cookie cache.** The cache holds a signed
 * copy for five minutes (P0-45), and trusting it here would let a
 * privilege-escalating action lean on a verification that has since gone stale
 * — or on a session that has since been revoked, which the row no longer holds
 * and the copy still vouches for.
 *
 * Three answers, each one the dashboard can act on:
 *
 * - no session row → 401, sign in again;
 * - no second factor at all → `mfa_required`, the enrolment screen;
 * - a second factor proved more than fifteen minutes ago → `step_up_required`,
 *   a code prompt, after which the same request succeeds.
 *
 * Mounted after `requireCapability`, so an EDITOR is refused for their role
 * before being asked for a code that would not help.
 *
 * **The guard carries a tag**, as a capability guard does (P0-50), so a test can
 * walk the router and prove which routes have it: a sensitive route that lost
 * its step-up behaves identically to one that kept it for every caller whose
 * verification happens to be fresh.
 */
export interface StepUpGuard extends MiddlewareHandler<AppEnv> {
  readonly stepUp: true;
}

export const requireStepUp = (auth: Pick<AuthPort, 'stepUpState'>): StepUpGuard => {
  const guard: MiddlewareHandler<AppEnv> = async (c, next) => {
    const state = await auth.stepUpState(c.req.raw.headers);

    if (state === null) throw new UnauthenticatedError();

    /*
     * Both reads come from one cookie, so they name one user. Checked anyway:
     * it costs a comparison, and a mismatch is a bug worth a refusal rather
     * than a step-up credited to somebody else. Separate from the null check,
     * so an unset user can never compare equal to an absent one.
     */
    if (state.userId !== c.get('userId')) throw new UnauthenticatedError();

    if (!state.twoFactorEnabled) throw new MfaRequiredError();

    if (!state.fresh) throw new StepUpRequiredError();

    await next();
  };

  return Object.assign(guard, { stepUp: true as const });
};

export const isStepUpGuard = (handler: unknown): boolean =>
  typeof handler === 'function' && 'stepUp' in handler && handler.stepUp === true;
