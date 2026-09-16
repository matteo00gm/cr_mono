import { describe, expect, it } from 'vitest';

import {
  assertModelPriced,
  CHAT_MESSAGE,
  costMicrosFor,
  MODEL_PRICES,
  periodOf,
  UnpricedModelError,
} from '../src/usage.js';

/**
 * What a turn cost (P2-31).
 *
 * Every failure here is silent and arrives as money. A model nobody priced
 * meters at nought and the margin dashboard believes it; a cost rounded down
 * makes a million cheap turns free; a period written in the wrong shape is
 * invisible to the quota query, which then fails *open*.
 */

describe('the price table', () => {
  it('prices the default the plan runs on', () => {
    // §5.3: Nova Lite at 0.06 / 0.24 per MTok. The number this whole cost model
    // is built on, so it is pinned rather than inferred.
    expect(MODEL_PRICES['amazon.nova-lite-v1:0']).toEqual({
      inputPerMTok: 0.06,
      outputPerMTok: 0.24,
    });
  });

  it('prices the escalation tier P2-28 sends the hard questions to', () => {
    expect(MODEL_PRICES['amazon.nova-2-lite-v1:0']).toBeDefined();
  });

  it('covers every model that can be configured, and nothing else', () => {
    /*
     * The row wants adding a provider without a price to be a CI failure. This
     * is where that bites: the table *is* the list of models the platform may
     * run, because `costMicrosFor` refuses anything absent from it. A new model
     * added to a provider adapter and not added here fails this case.
     */
    expect(Object.keys(MODEL_PRICES).toSorted()).toEqual([
      'amazon.nova-2-lite-v1:0',
      'amazon.nova-lite-v1:0',
      'amazon.nova-micro-v1:0',
      'claude-haiku-4-5',
      'claude-opus-5',
      'gemini-3.1-flash-lite',
      'gemini-3.5-flash-lite',
    ]);
  });

  it('does not price the model §5.3 says not to build on', () => {
    // Gemini 2.5 Flash-Lite is the cheapest number on that board and retires on
    // 16 October 2026. Pricing it here would make it configurable, which is the
    // one thing the table says not to do.
    expect(MODEL_PRICES['gemini-2.5-flash-lite']).toBeUndefined();
  });

  it('charges more for output than for input, as every provider does', () => {
    for (const [model, price] of Object.entries(MODEL_PRICES)) {
      expect(price.inputPerMTok, model).toBeGreaterThan(0);
      expect(price.outputPerMTok, model).toBeGreaterThan(price.inputPerMTok);
    }
  });
});

describe('what a turn costs', () => {
  it('computes it from the tokens the provider reported', () => {
    // 1,000 in and 500 out on Nova Lite: 1000 × 0.06/1e6 + 500 × 0.24/1e6
    // dollars = 0.00018, which is 180 micros.
    expect(
      costMicrosFor({ model: 'amazon.nova-lite-v1:0', inputTokens: 1000, outputTokens: 500 }),
    ).toBe(180);
  });

  it('is an integer, because these are summed across hundreds of thousands of rows', () => {
    const cost = costMicrosFor({
      model: 'amazon.nova-lite-v1:0',
      inputTokens: 1337,
      outputTokens: 419,
    });

    expect(Number.isInteger(cost)).toBe(true);
  });

  it('rounds a fraction of a micro up, never down', () => {
    /*
     * A turn that costs a fraction of a micro costs us that fraction, and
     * rounding to nought turns a million cheap turns into a free million. Half
     * a micro is not worth arguing about; a systematic bias towards nought is.
     */
    expect(costMicrosFor({ model: 'amazon.nova-lite-v1:0', inputTokens: 1, outputTokens: 0 })).toBe(
      1,
    );
  });

  it('costs nothing for a turn that spent nothing', () => {
    expect(costMicrosFor({ model: 'amazon.nova-lite-v1:0', inputTokens: 0, outputTokens: 0 })).toBe(
      0,
    );
  });

  it('refuses a model nobody priced rather than metering it at nought', () => {
    expect(() =>
      costMicrosFor({ model: 'some-new-model', inputTokens: 100, outputTokens: 100 }),
    ).toThrow(UnpricedModelError);
  });

  it('names the model in the refusal, so the fix is obvious', () => {
    expect(() =>
      costMicrosFor({ model: 'some-new-model', inputTokens: 1, outputTokens: 1 }),
    ).toThrow(/some-new-model/);
  });
});

describe('refusing an unpriced model at startup', () => {
  it('passes a priced one through, so it can be used inline', () => {
    expect(assertModelPriced('amazon.nova-lite-v1:0')).toBe('amazon.nova-lite-v1:0');
  });

  it('throws on one that is not', () => {
    // At startup rather than on a turn: without it the failure is a request
    // that errors *after* the model was called and paid for.
    expect(() => assertModelPriced('some-new-model')).toThrow(UnpricedModelError);
  });

  it('is not fooled by a name inherited from Object.prototype', () => {
    // `'constructor' in MODEL_PRICES` is true for every object. `Object.hasOwn`
    // is why "toString" is not a priced model.
    expect(() => assertModelPriced('constructor')).toThrow(UnpricedModelError);
    expect(() => assertModelPriced('toString')).toThrow(UnpricedModelError);
  });
});

describe('the billing period', () => {
  it('is YYYYMM, which is what the column CHECK accepts', () => {
    expect(periodOf(new Date('2026-09-16T08:30:00Z'))).toBe('202609');
  });

  it('pads a single-digit month', () => {
    // `2026-1` would pass a naive format check and be invisible to the quota
    // lookup, which is an equality — and a quota that finds nothing fails open.
    expect(periodOf(new Date('2026-01-01T00:00:00Z'))).toBe('202601');
  });

  it('matches the format the database enforces', () => {
    expect(periodOf(new Date('2026-12-31T23:59:59Z'))).toMatch(/^[0-9]{6}$/);
  });

  it('reads the month in UTC, not wherever the request landed', () => {
    /*
     * A tenant's month must not depend on which region answered. Just before
     * midnight UTC on the last day of September is September everywhere, and a
     * local-time reading would put it in October for half the world — moving a
     * message across a quota boundary.
     */
    expect(periodOf(new Date('2026-09-30T23:30:00Z'))).toBe('202609');
    expect(periodOf(new Date('2026-10-01T00:30:00Z'))).toBe('202610');
  });
});

describe('what a turn is metered as', () => {
  it('is the kind the quota counts', () => {
    expect(CHAT_MESSAGE).toBe('chat_message');
  });
});
