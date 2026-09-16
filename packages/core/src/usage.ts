/**
 * What a turn cost, and what it is billed as (P2-31, §5.3).
 *
 * **The price table is checked in, not fetched.** A cost computed from a
 * number that can change under a running service is a cost nobody can
 * reproduce — and a bill a seller disputes is settled by reading the table as
 * of that deploy. Prices move; a commit is how we know which one applied.
 *
 * **Micros, and integers.** Costs are summed across hundreds of thousands of
 * rows and compared against a plan's allowance; in binary floating point that
 * sum depends on the order it was taken in. `usage_events.cost_micros` is a
 * `bigint` for the same reason, and micros of euros overflow `integer` at about
 * €2,147.
 *
 * **An unpriced model cannot produce a cost.** It throws rather than billing
 * nought, because nought is a number a dashboard will display and a margin
 * calculation will believe.
 */

export interface ModelPrice {
  /** Dollars per million input tokens, exactly as §5.3's table states it. */
  readonly inputPerMTok: number;
  /** Dollars per million output tokens. */
  readonly outputPerMTok: number;
}

/**
 * §5.3's candidate models, at the prices that table names.
 *
 * Every model the platform may be configured with is here, and that is what
 * makes this the list rather than a sample: `costMicrosFor` refuses anything
 * absent, so a provider added without a price fails on its first turn instead
 * of metering it at nought.
 *
 * **Gemini 2.5 Flash-Lite is deliberately absent.** It is the cheapest number
 * on §5.3's board and it retires on 16 October 2026; pricing it here would make
 * it configurable, which is the one thing that table says not to do.
 */
export const MODEL_PRICES: Readonly<Record<string, ModelPrice>> = {
  'amazon.nova-micro-v1:0': { inputPerMTok: 0.035, outputPerMTok: 0.14 },
  /** The default (§5.3, §4.5). */
  'amazon.nova-lite-v1:0': { inputPerMTok: 0.06, outputPerMTok: 0.24 },
  /** The escalation target §5.3 calls sensible. */
  'amazon.nova-2-lite-v1:0': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'gemini-3.1-flash-lite': { inputPerMTok: 0.25, outputPerMTok: 1.5 },
  'gemini-3.5-flash-lite': { inputPerMTok: 0.3, outputPerMTok: 2.5 },
  'claude-haiku-4-5': { inputPerMTok: 1, outputPerMTok: 5 },
  'claude-opus-5': { inputPerMTok: 5, outputPerMTok: 25 },
};

export class UnpricedModelError extends Error {
  constructor(model: string) {
    super(
      `No price is checked in for "${model}", so what it costs cannot be computed. Add it ` +
        'to MODEL_PRICES with the figure from §5.3 rather than metering it at nought — a ' +
        'zero cost is a number the margin dashboard will believe (P2-31).',
    );
    this.name = 'UnpricedModelError';
  }
}

/**
 * Refuses, at startup, a model nobody priced.
 *
 * Called where the provider is built, so a deployment configured with an
 * unpriced model fails and the previous version keeps answering — the same
 * placement and the same argument as `assertQueryProviderMatchesIndex` (P2-17).
 * Without it the failure is a turn that errors after the model was called and
 * paid for.
 */
export const assertModelPriced = (model: string): string => {
  if (!Object.hasOwn(MODEL_PRICES, model)) throw new UnpricedModelError(model);

  return model;
};

export interface TurnCost {
  readonly model: string;
  readonly inputTokens: number;
  readonly outputTokens: number;
}

/**
 * What one turn cost, in micros of a dollar.
 *
 * **Rounded up.** A turn that costs a fraction of a micro costs us that
 * fraction, and rounding to nought turns a million cheap turns into a free
 * million. Half a micro is not worth arguing about; a systematic bias towards
 * nought is.
 */
export const costMicrosFor = ({ model, inputTokens, outputTokens }: TurnCost): number => {
  const price = MODEL_PRICES[model];

  if (price === undefined) throw new UnpricedModelError(model);

  const dollars =
    (inputTokens * price.inputPerMTok + outputTokens * price.outputPerMTok) / 1_000_000;

  return Math.ceil(dollars * 1_000_000);
};

/**
 * The billing period a moment falls in, as `usage_events.period` spells it.
 *
 * **UTC, and `YYYYMM` as text.** The column's `CHECK` enforces the format
 * because the quota lookup (P2-36) is an indexed equality on it: a single row
 * written as `2026-09` would be invisible to that query, which fails *open* and
 * silently grants unlimited usage. UTC because a tenant's month must not depend
 * on which region answered the request.
 */
export const periodOf = (at: Date): string =>
  `${String(at.getUTCFullYear())}${String(at.getUTCMonth() + 1).padStart(2, '0')}`;

/** What `usage_events.kind` says for one answered question. */
export const CHAT_MESSAGE = 'chat_message';
