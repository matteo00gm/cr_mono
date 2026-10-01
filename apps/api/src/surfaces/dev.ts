import {
  DEV_TRANSITIONS,
  InvalidRequestError,
  PLAN_IDS,
  type MembershipReader,
} from '@catalogorosso/core';
import { requires, type RouteAccess } from '@catalogorosso/security';
import { Hono } from 'hono';
import { z } from 'zod';

import type { DevBillingPort } from '../dev-billing.js';
import type { AppEnv } from '../env.js';
import { requireUser, type AuthPort } from '../middleware/auth.js';
import { requireCapability, routeKey } from '../middleware/capability.js';
import { requireSameOrigin } from '../middleware/same-origin.js';
import { resolveTenant } from '../middleware/tenant.js';
import { DEV_PREFIX } from '../routes.js';

/**
 * The non-production surface (P5-14): moving the session's own winery through
 * its billing states for QA and demos, by the webhook path.
 *
 * **Absent in production, not disabled there.** `createApp` mounts this only
 * when the composition root hands it a port, the composition root hands it one
 * only off production, and `createApp` throws at startup if it is ever handed
 * one in production or finds a `/v1/dev` route in a production table.
 *
 * **Still the session's own winery, and still an owner.** The same chain the
 * dashboard runs — same origin, a session, the tenant from a membership, never
 * from the request (P0-48), `billing:manage` with its second factor — because a
 * dev stage holds real accounts too, and this changes what one of them is.
 */

export interface DevAppOptions {
  readonly auth: AuthPort;
  readonly readMemberships: MembershipReader;
  readonly dashboardOrigin?: string | undefined;
  readonly devBilling: DevBillingPort;
}

const transitionBody = z.strictObject({
  transition: z.enum(DEV_TRANSITIONS),
  plan: z.enum(PLAN_IDS).optional(),
});

export const createDevApp = ({
  auth,
  readMemberships,
  dashboardOrigin,
  devBilling,
}: DevAppOptions): Hono<AppEnv> => {
  const app = new Hono<AppEnv>();

  if (dashboardOrigin !== undefined) app.use('*', requireSameOrigin(dashboardOrigin));

  app.use('*', requireUser(auth));
  app.use('*', resolveTenant(readMemberships));

  app.post('/billing-state', requireCapability('billing:manage'), async (c) => {
    let body: unknown;

    try {
      body = await c.req.json();
    } catch {
      body = undefined;
    }

    const parsed = transitionBody.safeParse(body);

    if (!parsed.success) {
      throw new InvalidRequestError(
        `Send a JSON body naming a transition: ${DEV_TRANSITIONS.join(', ')}; and optionally a plan: ` +
          `${PLAN_IDS.join(', ')}.`,
      );
    }

    return c.json(
      await devBilling.apply(c.get('tenantId'), parsed.data.transition, parsed.data.plan),
    );
  });

  return app;
};

export const DEV_ROUTE_ACCESS: ReadonlyMap<string, RouteAccess> = new Map<string, RouteAccess>([
  [routeKey('POST', `${DEV_PREFIX}/billing-state`), requires('billing:manage')],
]);

/** A `/v1/dev` route, or the port behind them, reached a production app. */
export class DevSurfaceInProductionError extends Error {
  constructor(detail: string) {
    super(
      `The dev surface is not allowed in production (P5-14): ${detail}. It can set any ` +
        'winery’s billing state, so it ships nowhere it could be reached by a customer.',
    );
    this.name = 'DevSurfaceInProductionError';
  }
}
