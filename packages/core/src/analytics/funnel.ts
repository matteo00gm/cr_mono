/**
 * The funnel (P6-02, §2.4): how many visits reached each stage, and how many
 * of those went on to the next.
 *
 * **A stage counts every visit that reached it or anything after it.** The
 * events are fire-and-forget (P3-20): a `WIDGET_OPEN` lost to a closed tab, or
 * stamped the night before the range began, would otherwise leave a visit that
 * added a wine to its cart counted as never having opened the widget — and a
 * funnel that widens is one a seller stops believing. Counted by the furthest
 * stage reached, it never does, and every step is at most 100%.
 *
 * **An order is not a stage yet.** §2.4's funnel ends at an order, but an order
 * is only seen once the Shopify webhook is connected (P6-07). Until then the
 * last stage is the add to cart, and it is labelled as one — never as a sale.
 */

/** The four stages, in order. Each is a `widget_event_type`. */
export const FUNNEL_STAGES = [
  'WIDGET_OPEN',
  'MESSAGE_SENT',
  'RECOMMENDATION_SHOWN',
  'ADD_TO_CART',
] as const;

export type FunnelStage = (typeof FUNNEL_STAGES)[number];

export interface FunnelStep {
  readonly stage: FunnelStage;
  /** Visits that reached this stage or a later one. */
  readonly sessions: number;
  /**
   * The share of the previous stage's visits that reached this one, 0 to 1.
   * `null` for the first stage, which has no previous, and after a stage that
   * nobody reached — a rate of nothing is not a rate of zero.
   */
  readonly rate: number | null;
}

/**
 * The steps, from how many visits reached each stage at least.
 *
 * Takes the counts as the store gives them and holds them to the rule above
 * rather than trusting it: a count larger than the one before is clamped to
 * it, so a store that ever disagreed would show a flat step, not a rate over
 * 100%.
 */
export const funnelOf = (reached: Readonly<Record<FunnelStage, number>>): FunnelStep[] => {
  const steps: FunnelStep[] = [];
  let previous: number | undefined;

  for (const stage of FUNNEL_STAGES) {
    const sessions = previous === undefined ? reached[stage] : Math.min(reached[stage], previous);

    steps.push({
      stage,
      sessions,
      rate: previous === undefined || previous === 0 ? null : sessions / previous,
    });
    previous = sessions;
  }

  return steps;
};
