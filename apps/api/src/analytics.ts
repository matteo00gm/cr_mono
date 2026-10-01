import type { FunnelResponse } from '@catalogorosso/api-client';
import { analyticsRange, FUNNEL_STAGES, funnelOf, type FunnelStage } from '@catalogorosso/core';
import { readFunnel, withTenant, type FunnelQuery } from '@catalogorosso/db';

/**
 * What visitors did with the sommelier (P6-02, §2.4), for the dashboard.
 *
 * **Each panel is one method here, and each reads through a repository
 * function** — the store answers how many, `packages/core` decides what the
 * numbers mean, and this joins the two in the tenant's scope. A panel that
 * later reads an aggregate instead of raw events changes the store and nothing
 * else.
 */

/** The range a request asked for: either end may be absent (core's `analyticsRange`). */
export interface RangeAsked {
  readonly from?: string | undefined;
  readonly to?: string | undefined;
}

export interface AnalyticsPort {
  /** Visits reaching each stage, and the share of each step (P6-02). */
  readonly funnel: (tenantId: string, asked: RangeAsked) => Promise<FunnelResponse>;
}

export interface AnalyticsPortDeps {
  /** The funnel's counts for a tenant. Defaults to `readFunnel` in the tenant's scope. */
  readonly readFunnel?: ((tenantId: string, query: FunnelQuery) => Promise<number[]>) | undefined;
  /** Today, for a range that does not say. */
  readonly now?: (() => Date) | undefined;
}

/** The port with nothing behind it: a wiring error, loudly, never an empty funnel. */
export class AnalyticsPortNotConfiguredError extends Error {
  constructor() {
    super(
      'No analytics port was supplied to createApp, so a panel cannot be read. ' +
        'This is a wiring bug at the composition root, not a request problem.',
    );
    this.name = 'AnalyticsPortNotConfiguredError';
  }
}

export const unconfiguredAnalytics: AnalyticsPort = {
  funnel: () => Promise.reject(new AnalyticsPortNotConfiguredError()),
};

export const createAnalyticsPort = ({
  readFunnel: read = (tenantId, query) => withTenant(tenantId, (tx) => readFunnel(tx, query)),
  now = () => new Date(),
}: AnalyticsPortDeps = {}): AnalyticsPort => ({
  funnel: async (tenantId, asked) => {
    const range = analyticsRange(asked, now());
    const counts = await read(tenantId, {
      stages: FUNNEL_STAGES,
      start: range.start,
      end: range.end,
    });
    const reached = Object.fromEntries(
      FUNNEL_STAGES.map((stage, index) => [stage, counts[index] ?? 0]),
    ) as Record<FunnelStage, number>;

    return { from: range.from, to: range.to, stages: funnelOf(reached) };
  },
});
