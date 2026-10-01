import { describe, expect, it } from 'vitest';

import { FUNNEL_STAGES, funnelOf, type FunnelStage } from '../../src/analytics/funnel.js';

/**
 * The funnel's arithmetic (P6-02). Which visits reach a stage is the store's
 * question, and is answered against Postgres in `funnel.integration.test.ts`;
 * what is held here is that the steps it reports can be believed.
 */

const reached = (
  open: number,
  message: number,
  shown: number,
  cart: number,
): Record<FunnelStage, number> => ({
  WIDGET_OPEN: open,
  MESSAGE_SENT: message,
  RECOMMENDATION_SHOWN: shown,
  ADD_TO_CART: cart,
});

describe('the stages', () => {
  it("are §2.4's, in order, ending at the cart until an order can be seen", () => {
    expect([...FUNNEL_STAGES]).toEqual([
      'WIDGET_OPEN',
      'MESSAGE_SENT',
      'RECOMMENDATION_SHOWN',
      'ADD_TO_CART',
    ]);
  });
});

describe('funnelOf', () => {
  it('reports each stage with the share of the one before that reached it', () => {
    expect(funnelOf(reached(200, 80, 60, 15))).toEqual([
      { stage: 'WIDGET_OPEN', sessions: 200, rate: null },
      { stage: 'MESSAGE_SENT', sessions: 80, rate: 0.4 },
      { stage: 'RECOMMENDATION_SHOWN', sessions: 60, rate: 0.75 },
      { stage: 'ADD_TO_CART', sessions: 15, rate: 0.25 },
    ]);
  });

  it('gives the first stage no rate, because it has nothing before it', () => {
    expect(funnelOf(reached(10, 5, 5, 5))[0]?.rate).toBeNull();
  });

  it('gives no rate after a stage nobody reached, rather than a rate of zero', () => {
    const steps = funnelOf(reached(10, 0, 0, 0));

    expect(steps.map((step) => step.rate)).toEqual([null, 0, null, null]);
  });

  it('is all zeros and no rates for a range with no visits', () => {
    expect(funnelOf(reached(0, 0, 0, 0))).toEqual(
      FUNNEL_STAGES.map((stage) => ({ stage, sessions: 0, rate: null })),
    );
  });

  it('never widens, whatever the store says', () => {
    /* A count above the one before would be a step over 100%: held flat instead. */
    const steps = funnelOf(reached(10, 12, 4, 9));

    expect(steps.map((step) => step.sessions)).toEqual([10, 10, 4, 4]);
    expect(steps.every((step) => step.rate === null || step.rate <= 1)).toBe(true);
  });

  it('keeps a full step at exactly one', () => {
    expect(funnelOf(reached(7, 7, 7, 7)).map((step) => step.rate)).toEqual([null, 1, 1, 1]);
  });
});
