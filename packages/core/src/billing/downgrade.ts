import { PLAN_IDS, PLANS, type PlanId } from '../plans.js';

/**
 * Whether a winery fits the plan it wants to move down to (P5-10).
 *
 * **Asked twice**: when the downgrade is scheduled, and again when it applies
 * at period end, because a winery can grow in the month between. The first
 * refusal is a message; the second keeps the winery on the plan it has, since
 * a downgrade that applied over the caps would break a live widget.
 */

/** What a winery holds that a plan caps. */
export interface PlanFootprint {
  /** Active wines: what the catalogue cap counts. Archived ones are not in it. */
  readonly wines: number;
  /** Production domains, counted as the domain cap counts them (P4-07, P4-19). */
  readonly domains: number;
}

export interface Blocker {
  readonly what: 'wines' | 'domains';
  readonly have: number;
  readonly allowed: number;
}

/** Everything the winery would have to reduce to fit `plan`, or nothing. */
export const downgradeBlockers = (footprint: PlanFootprint, plan: PlanId): Blocker[] => {
  const { skuCap, productionDomains } = PLANS[plan];
  const blockers: Blocker[] = [];

  if (footprint.wines > skuCap)
    blockers.push({ what: 'wines', have: footprint.wines, allowed: skuCap });

  if (footprint.domains > productionDomains) {
    blockers.push({ what: 'domains', have: footprint.domains, allowed: productionDomains });
  }

  return blockers;
};

const count = (n: number, one: string, many: string) => `${String(n)} ${n === 1 ? one : many}`;

/**
 * What the owner is told, naming each thing to reduce **and by how much**.
 *
 * A bare "you cannot downgrade" produces a support ticket every time (P5-10);
 * "archive 112 wines" is something they can do this afternoon.
 */
export const downgradeRefusal = (plan: PlanId, blockers: readonly Blocker[]): string => {
  const { name } = PLANS[plan];
  const cuts = blockers.map(({ what, have, allowed }) =>
    what === 'wines'
      ? `archive ${count(have - allowed, 'wine', 'wines')} (${String(have)} of ${String(allowed)})`
      : `remove ${count(have - allowed, 'domain', 'domains')} (${String(have)} of ${String(allowed)})`,
  );

  return `${name} allows ${count(PLANS[plan].skuCap, 'wine', 'wines')} and ${count(
    PLANS[plan].productionDomains,
    'domain',
    'domains',
  )}. To move to ${name}, ${cuts.join(' and ')} first.`;
};

/** Whether moving from one plan to another is down the ladder (`PLAN_IDS` is cheapest first). */
export const isDowngrade = (from: PlanId, to: PlanId): boolean =>
  PLAN_IDS.indexOf(to) < PLAN_IDS.indexOf(from);
