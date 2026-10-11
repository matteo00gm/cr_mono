import type {
  FunnelResponse,
  RefusedOriginsResponse,
  SalesResponse,
  TopResponse,
  ZeroResultsResponse,
} from '@catalogorosso/api-client';
import {
  analyticsRange,
  FUNNEL_STAGES,
  funnelOf,
  MIN_QUERY_CONVERSATIONS,
  REFUSED_ORIGINS_LIMIT,
  THEMES,
  themesOf,
  TOP_LIMIT,
  ZERO_RESULTS_LIMIT,
  type FunnelStage,
} from '@catalogorosso/core';
import {
  hasInstalledShop,
  readAttributedSales,
  readFunnel,
  readRefusedOrigins,
  readTopProducts,
  readTopQueries,
  readZeroResults,
  withTenant,
  type AttributedSales,
  type FunnelQuery,
  type RefusedOrigin,
  type RefusedOriginsQuery,
  type SalesQuery,
  type TopProduct,
  type TopProductsQuery,
  type TopQueriesQuery,
  type TopQuery,
  type UnansweredQuestion,
  type ZeroResultsQuery,
} from '@catalogorosso/db';

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
  /** The questions most asked and the wines most recommended (P6-03). */
  readonly top: (tenantId: string, asked: RangeAsked) => Promise<TopResponse>;
  /** The questions the catalogue could not answer, and their patterns (P6-04). */
  readonly zeroResults: (tenantId: string, asked: RangeAsked) => Promise<ZeroResultsResponse>;
  /** The sites refused for this winery's key, and what became of each (P6-05). */
  readonly refusedOrigins: (tenantId: string, asked: RangeAsked) => Promise<RefusedOriginsResponse>;
  /** What the sommelier sold, and whether a sale can be seen at all (P6-10). */
  readonly sales: (tenantId: string, asked: RangeAsked) => Promise<SalesResponse>;
}

export interface AnalyticsPortDeps {
  /** The funnel's counts for a tenant. Defaults to `readFunnel` in the tenant's scope. */
  readonly readFunnel?: ((tenantId: string, query: FunnelQuery) => Promise<number[]>) | undefined;
  /**
   * The top questions and wines for a tenant, in one scope. Defaults to
   * `readTopQueries` and `readTopProducts` in one `withTenant`.
   */
  readonly readTop?:
    | ((
        tenantId: string,
        queries: TopQueriesQuery,
        products: TopProductsQuery,
      ) => Promise<{ readonly queries: TopQuery[]; readonly products: TopProduct[] }>)
    | undefined;
  /** Every unanswered question for a tenant. Defaults to `readZeroResults` in its scope. */
  readonly readZeroResults?:
    ((tenantId: string, query: ZeroResultsQuery) => Promise<UnansweredQuestion[]>) | undefined;
  /** The refused sites for a tenant. Defaults to `readRefusedOrigins` in its scope. */
  readonly readRefusedOrigins?:
    ((tenantId: string, query: RefusedOriginsQuery) => Promise<RefusedOrigin[]>) | undefined;
  /**
   * What was sold for a tenant, or `undefined` when no shop is connected and a
   * sale could not have been seen. Defaults to `hasInstalledShop` and, only if
   * so, `readAttributedSales`, in one scope.
   */
  readonly readSales?:
    ((tenantId: string, query: SalesQuery) => Promise<AttributedSales | undefined>) | undefined;
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
  top: () => Promise.reject(new AnalyticsPortNotConfiguredError()),
  zeroResults: () => Promise.reject(new AnalyticsPortNotConfiguredError()),
  refusedOrigins: () => Promise.reject(new AnalyticsPortNotConfiguredError()),
  sales: () => Promise.reject(new AnalyticsPortNotConfiguredError()),
};

/**
 * The patterns above the list: for each theme, the conversations whose
 * unanswered questions use its words — each counted once, however many of
 * its questions do — most asked first, and none that nobody asked about.
 */
const themesAcross = (questions: readonly UnansweredQuestion[]) =>
  THEMES.map((theme) => ({
    id: theme.id,
    label: theme.label,
    conversations: new Set(
      questions
        .filter((question) => themesOf(question.question).includes(theme))
        .flatMap((question) => question.conversationIds),
    ).size,
  }))
    .filter((theme) => theme.conversations > 0)
    .sort((a, b) => b.conversations - a.conversations);

/** Both reads in one transaction, so the two lists describe the same moment. */
const readTopInScope: NonNullable<AnalyticsPortDeps['readTop']> = (tenantId, queries, products) =>
  withTenant(tenantId, async (tx) => ({
    queries: await readTopQueries(tx, queries),
    products: await readTopProducts(tx, products),
  }));

/**
 * Whether a sale can be seen, and then what was sold — in that order, in one
 * transaction. The second read is not made for a winery with no shop: its
 * answer would be noughts that mean "unmeasured", and reading them is how they
 * end up on a screen as sales.
 */
const readSalesInScope: NonNullable<AnalyticsPortDeps['readSales']> = (tenantId, query) =>
  withTenant(tenantId, async (tx) =>
    (await hasInstalledShop(tx)) ? readAttributedSales(tx, query) : undefined,
  );

export const createAnalyticsPort = ({
  readFunnel: read = (tenantId, query) => withTenant(tenantId, (tx) => readFunnel(tx, query)),
  readTop = readTopInScope,
  readZeroResults: readUnanswered = (tenantId, query) =>
    withTenant(tenantId, (tx) => readZeroResults(tx, query)),
  readRefusedOrigins: readRefused = (tenantId, query) =>
    withTenant(tenantId, (tx) => readRefusedOrigins(tx, query)),
  readSales = readSalesInScope,
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

  top: async (tenantId, asked) => {
    const range = analyticsRange(asked, now());
    const { queries, products } = await readTop(
      tenantId,
      {
        start: range.start,
        end: range.end,
        minConversations: MIN_QUERY_CONVERSATIONS,
        limit: TOP_LIMIT,
      },
      { start: range.start, end: range.end, limit: TOP_LIMIT },
    );

    return {
      from: range.from,
      to: range.to,
      queries: queries.map((query) => ({
        query: query.query,
        conversations: query.conversations,
        lastAskedAt: query.lastAskedAt.toISOString(),
      })),
      /* Every row was shown at least once, so `recommended` is never zero. */
      products: products.map((product) => ({
        productId: product.productId,
        name: product.name,
        archived: product.archived,
        recommended: product.recommended,
        addedToCart: product.added,
        rate: product.added / product.recommended,
      })),
    };
  },

  zeroResults: async (tenantId, asked) => {
    const range = analyticsRange(asked, now());
    const questions = await readUnanswered(tenantId, { start: range.start, end: range.end });

    return {
      from: range.from,
      to: range.to,
      conversations: new Set(questions.flatMap((question) => question.conversationIds)).size,
      themes: themesAcross(questions),
      questions: questions.slice(0, ZERO_RESULTS_LIMIT).map((question) => ({
        question: question.question,
        conversations: question.conversationIds.length,
        noMatch: question.noMatch,
        notRecommended: question.notRecommended,
        lastAskedAt: question.lastAskedAt.toISOString(),
      })),
    };
  },

  refusedOrigins: async (tenantId, asked) => {
    const range = analyticsRange(asked, now());
    const origins = await readRefused(tenantId, {
      start: range.start,
      end: range.end,
      limit: REFUSED_ORIGINS_LIMIT,
    });

    return {
      from: range.from,
      to: range.to,
      origins: origins.map((refused) => ({
        origin: refused.origin,
        attempts: refused.attempts,
        sources: refused.sources,
        lastSeenAt: refused.lastSeenAt.toISOString(),
        domain: refused.domainStatus,
      })),
    };
  },

  sales: async (tenantId, asked) => {
    const range = analyticsRange(asked, now());
    const sold = await readSales(tenantId, { start: range.start, end: range.end });

    return {
      from: range.from,
      to: range.to,
      /* The flag every revenue label hangs on (P6-10): a shop is connected, so an order reaches us. */
      hasOrderAttribution: sold !== undefined,
      orders: sold?.orders ?? 0,
      visits: sold?.visits ?? 0,
      units: sold?.units ?? 0,
      amounts: [...(sold?.amounts ?? [])],
    };
  },
});
