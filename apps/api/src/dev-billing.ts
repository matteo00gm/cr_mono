import {
  ConflictError,
  NotFoundError,
  SyntheticEventRefused,
  syntheticBillingEvent,
  type DevTransition,
  type PlanId,
} from '@catalogorosso/core';
import { readBillingState, withTenant, type BillingState } from '@catalogorosso/db';

import type { StripeEventsPort } from './stripe-events.js';

/**
 * Moving a winery's billing state on a non-production stage (P5-14).
 *
 * **Through the webhook path, never a direct write.** Each transition is a
 * Stripe-shaped event we write ourselves (`syntheticBillingEvent`), recorded
 * through the same port a signed delivery reaches: attributed, claimed once,
 * run through the state machine, audited. A state the machine would refuse is
 * refused here too, and the answer says whether the event changed anything.
 *
 * **This module is never wired in production** — the composition root leaves
 * it out, and `createApp` refuses to mount it there (P5-14). A switch that can
 * set any winery `ACTIVE` is worth more to an attacker than any other route in
 * the system, so it is absent rather than disabled.
 */

export interface DevBillingAnswer {
  /** Whether the state machine applied the event. */
  readonly applied: boolean;
  readonly status: BillingState['status'];
  readonly plan: PlanId | null;
}

export interface DevBillingPort {
  readonly apply: (
    tenantId: string,
    transition: DevTransition,
    plan?: PlanId,
  ) => Promise<DevBillingAnswer>;
}

export interface DevBillingDeps {
  readonly stripeEvents: StripeEventsPort;
  readonly readState?: ((tenantId: string) => Promise<BillingState | undefined>) | undefined;
  /** Stripe's seconds. Injected so a test can order two events. */
  readonly now?: (() => number) | undefined;
}

export const createDevBillingPort = ({
  stripeEvents,
  readState = (tenantId) => withTenant(tenantId, readBillingState),
  now = () => Math.floor(Date.now() / 1000),
}: DevBillingDeps): DevBillingPort => ({
  async apply(tenantId, transition, plan) {
    const before = await readState(tenantId);

    if (before === undefined) throw new NotFoundError();

    let event;

    try {
      event = syntheticBillingEvent(transition, {
        tenantId,
        customerId: before.stripeCustomerId,
        subscriptionId: before.stripeSubscriptionId,
        plan: plan ?? before.plan ?? 'CANTINA',
        at: now(),
      });
    } catch (error) {
      if (error instanceof SyntheticEventRefused) throw new ConflictError(error.message);
      throw error;
    }

    const { applied } = await stripeEvents.record(event);
    const after = await readState(tenantId);

    if (after === undefined) throw new NotFoundError();

    return { applied, status: after.status, plan: after.plan };
  },
});
