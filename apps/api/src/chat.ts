import {
  allowlisted,
  assertModelPriced,
  capHistory,
  CHAT_MESSAGE,
  costMicrosFor,
  escalationsFor,
  MAX_HISTORY_TURNS,
  periodOf,
  replyLocale,
  QUOTA_EXCEEDED_MESSAGE,
  tierFor,
  withoutLeakedInstructions,
  withSchemaRepair,
  type CandidateProduct,
  type EmbeddingProvider,
  type EscalationReason,
  type LlmProvider,
  type PairingOutcome,
  type Recommendation,
  type SupportedLocale,
  type Turn,
} from '@catalogorosso/core';
import {
  readConversation,
  recordTurn,
  recordUsage,
  withTenant,
  type ProductRow,
} from '@catalogorosso/db';
import type { WidgetChatEvent, WidgetProduct } from '@catalogorosso/api-client';
import type { PairingUsage } from '@catalogorosso/llm';
import { redactPii } from '@catalogorosso/security';

import type { WidgetTenant } from './env.js';
import type { QuotaPort } from './quota.js';
import { retrieve } from './retrieval.js';

/**
 * Answering one visitor's question (P2-29, §4.5).
 *
 * **The order is security, not style.** Quota before retrieval and before
 * generation, because a check after the model call has already spent the money
 * it exists to save (P2-36). Then retrieval, then the prompt, then the stream —
 * and the boundary that makes the answer safe wraps the stream rather than
 * following it, so a card cannot be shown before it has been checked (P2-25).
 *
 * **Every step is a function that already exists and is tested where it lives.**
 * This file is composition: it decides the order and owns nothing else, which
 * is what keeps the sandbox's claim to run "the real path" true.
 *
 * **The turn is written after the stream ends**, in one transaction with the
 * bill (P2-30, P2-31). A visitor who closes the tab mid-answer still has what
 * was generated recorded, because what was generated was paid for.
 */

/** Refused before anything was spent. Its message reaches the visitor verbatim (P0-55). */
export class QuotaExceededError extends Error {
  readonly status = 429 as const;
  readonly code = 'QUOTA_EXCEEDED' as const;

  constructor() {
    super(QUOTA_EXCEEDED_MESSAGE);
    this.name = 'QuotaExceededError';
  }
}

/** A provider built for one turn, reporting that turn's tokens. */
export type ProviderFor = (onUsage: (usage: PairingUsage) => void) => LlmProvider;

export interface ProviderTierFactories {
  /** §5.3's default. */
  readonly base: ProviderFor;
  /** Where P2-28 sends the hard questions. */
  readonly strong: ProviderFor;
}

export interface ChatRequest {
  readonly tenant: WidgetTenant;
  /** From the verified token (P2-13), never from the body. */
  readonly sessionId: string;
  /** As CORS verified it (P2-08). */
  readonly origin: string;
  /** The visitor's address as P2-04 buckets it, or null when no secret is configured. */
  readonly visitorHash: string | null;
  /** What the visitor typed. Untrusted, and the only thing in the body that is read. */
  readonly message: string;
  /** Wired into the provider so a closed tab stops generation, and stops billing. */
  readonly signal: AbortSignal;
}

/** What a turn did, for the log line the route writes. Never reaches the visitor. */
export interface TurnReport {
  readonly outcome: PairingOutcome;
  readonly escalations: readonly EscalationReason[];
  readonly model: string;
  readonly candidates: number;
  readonly preCapCount: number;
  /** Recommendations the allowlist refused. Non-empty is worth alerting on (P2-25). */
  readonly dropped: readonly string[];
  /**
   * How many things P2-33 removed from the message. A count, never a value.
   *
   * Reporting what was removed would put it in a log, which is where it was
   * being kept out of. The count is enough to notice a spike.
   */
  readonly redacted: number;
  /** The language the reply was written in, and whether the message chose it (P2-34). */
  readonly locale: SupportedLocale;
  readonly localeDetected: boolean;
  /** How many earlier turns the caps left out (P2-35). */
  readonly historyDropped: number;
  /**
   * The reply was cut short because it began quoting the instructions (P2-32).
   *
   * **True is an attack that got as far as the model**, and it is the signal a
   * seeded tasting note produces when it works. The visitor sees a reply that
   * stops early; this is how anyone else finds out.
   */
  readonly leaked: boolean;
  readonly costMicros: number;
}

export interface ChatPort {
  /** Streams one answer, and records the turn when the stream ends. */
  readonly answer: (
    request: ChatRequest,
    onReport: (report: TurnReport) => void,
  ) => AsyncIterable<WidgetChatEvent>;
}

export interface ChatPortOptions {
  /** The query embedder (P2-17). */
  readonly embeddings: EmbeddingProvider;
  readonly providers: ProviderTierFactories;
  /** The model each tier names, for the bill. Asserted priced at startup (P2-31). */
  readonly models: { readonly base: string; readonly strong: string };
  readonly quota: QuotaPort;
  readonly now?: () => Date;
}

/**
 * A wine as the prompt renders it (P2-23).
 *
 * **Every field comes from our own row**, never from the model and never from
 * the fused candidate's ranking numbers — which is the same rule the widget
 * renders cards under (§3.7).
 */
/**
 * A wine as a shopper sees it (P3-08, §1.5, §3.7).
 *
 * **Narrower than the seller's own record, on purpose.** This is world-readable
 * on a storefront: no `sku`, and above all no `stockQty`, which would publish a
 * winery's inventory levels to anyone who asked.
 */
const asCard = (row: ProductRow): WidgetProduct => ({
  name: row.name,
  producer: row.producer,
  vintage: row.vintage,
  priceCents: row.priceCents,
  currency: row.currency,
  imageUrl: row.imageUrl,
  productUrl: row.productUrl,
  stockStatus: row.stockStatus,
  variantId: row.externalVariantId,
});

const asCandidate = (row: ProductRow): CandidateProduct => ({
  id: row.id,
  name: row.name,
  producer: row.producer,
  vintage: row.vintage,
  wineType: row.wineType,
  grapeVarieties: row.grapeVarieties,
  region: row.region,
  denomination: row.denomination,
  styleTags: row.styleTags,
  tastingNotes: row.tastingNotes,
  foodPairings: row.foodPairings,
  alcoholPct: row.alcoholPct,
  priceCents: row.priceCents,
});

export const createChatPort = ({
  embeddings,
  providers,
  models,
  quota,
  now = () => new Date(),
}: ChatPortOptions): ChatPort => {
  /*
   * Refused at construction rather than on a turn (P2-31). A model nobody
   * priced meters at nought, and nought is a number the margin dashboard
   * believes — so the deployment fails and the previous version keeps
   * answering.
   */
  assertModelPriced(models.base);
  assertModelPriced(models.strong);

  return {
    answer: ({ tenant, sessionId, origin, visitorHash, message, signal }, onReport) =>
      (async function* (): AsyncGenerator<WidgetChatEvent> {
        /*
         * **First, before anything is spent.** Retrieval is a query and
         * generation is a bill; a quota checked after either has already cost
         * what it exists to save (P2-36, §3.6).
         */
        if (!(await quota.check(tenant)).allowed) throw new QuotaExceededError();

        /*
         * **Redacted once, here, and nowhere else** (P2-33, §1.4). The same
         * string is embedded, put in the prompt and stored as the visitor's
         * message — redacting at each of those would be three chances for one
         * to be added later without it. Visitors volunteer contact details
         * unprompted, and none of it should reach a model, a provider's logs,
         * or a transcript that lives ninety days.
         */
        const { text: question, removed } = redactPii(message);

        const { fused, rows, capped } = await retrieve(
          { provider: embeddings },
          { tenantId: tenant.tenantId, query: question },
        );

        const byId = new Map(rows.map((row) => [row.id, row]));
        const candidates = capped.candidates.flatMap((candidate) => {
          const row = byId.get(candidate.productId);

          return row === undefined ? [] : [asCandidate(row)];
        });

        /*
         * **The shop's locale is the tie-breaker, not English** (P2-34). A
         * three-word message is not reliably detectable, and a winery in
         * Piemonte whose visitor typed something ambiguous is answered in
         * Italian far more often than not.
         */
        const { locale, detected } = replyLocale(question, tenant.locale);

        const history: Turn[] = (
          await withTenant(tenant.tenantId, (tx) =>
            readConversation(tx, sessionId, MAX_HISTORY_TURNS * 2),
          )
        ).flatMap((entry) =>
          entry.role === 'SYSTEM'
            ? []
            : [{ role: entry.role === 'USER' ? 'user' : 'assistant', content: entry.content }],
        );

        /*
         * **Two controls in one number** (P2-35, §1.4). History is the largest
         * variable part of a prompt, so it is what the bill scales with — and
         * every earlier turn is text a visitor wrote, so it is attack surface
         * that grows with the conversation.
         */
        const recent = capHistory(history);

        /*
         * **A provider swap, not a second code path** (P2-28). The schema
         * signal is false here because nothing has been asked yet; P2-27's
         * repair is what handles a first attempt that misses it.
         */
        const escalations = escalationsFor({
          topScore: fused[0]?.score,
          query: question,
          schemaFailed: false,
        });

        let usage: PairingUsage | undefined;
        const record = (reported: PairingUsage): void => {
          usage = reported;
        };

        const tiers = {
          base: providers.base(record),
          strong: providers.strong(record),
        };
        const provider = tierFor(tiers, escalations);
        const model = escalations.length > 0 ? models.strong : models.base;

        let outcome: PairingOutcome = 'provider_error';
        const dropped: string[] = [];
        let reply = '';
        let leaked = false;

        /*
         * **Two boundaries, both wrapping the stream rather than following it**
         * (P2-25, P2-32). The inner one refuses an id outside this request's
         * candidates; the outer refuses text quoting our instructions, which
         * the adapters stream before `trustedPairing` ever sees a parsed reply.
         * Neither can be applied after the fact: a chunk yielded is a chunk
         * sent.
         */
        const answered = withoutLeakedInstructions(
          allowlisted(
            withSchemaRepair(
              provider,
              { query: question, locale, candidates, history: recent.turns },
              signal,
              {
                onOutcome: (reported) => {
                  outcome = reported;
                },
              },
            ),
            new Set(candidates.map((candidate) => candidate.id)),
            (refused: readonly Recommendation[]) => {
              dropped.push(...refused.map((item) => item.productId));
            },
          ),
          () => {
            leaked = true;
          },
        );

        const started = now().getTime();

        try {
          for await (const chunk of answered) {
            if (chunk.type === 'text') reply += chunk.delta;

            /*
             * **The card is attached here, from our own rows** (P3-08, §1.5).
             * The model named an id and wrote a reason; every other field a
             * visitor will see is read out of `byId`, so a card cannot carry a
             * name, a price or a URL the model wrote.
             *
             * **The `undefined` branch is unreachable and stays anyway.**
             * `allowlisted` (P2-25) has already refused any id outside this
             * request's candidates, and `candidates` is built from `byId` — so
             * a missing row cannot happen, which mutation testing confirms by
             * changing this line and killing nothing. `Map.get` is partial, and
             * the alternative to dropping is a non-null assertion that would be
             * wrong the day the allowlist moves.
             */
            if (chunk.type !== 'recommendations') {
              yield chunk;
              continue;
            }

            yield {
              type: 'recommendations',
              items: chunk.items.flatMap((item) => {
                const row = byId.get(item.productId);

                return row === undefined ? [] : [{ ...item, product: asCard(row) }];
              }),
            };
          }
        } finally {
          /*
           * **After the stream, in one transaction, however it ended.** A
           * visitor who closed the tab still has what was generated recorded,
           * because what was generated was paid for — and a `finally` is what
           * makes that true of an abort as well as of a clean finish.
           */
          const costMicros =
            usage === undefined
              ? 0
              : costMicrosFor({
                  model,
                  inputTokens: usage.inputTokens,
                  outputTokens: usage.outputTokens,
                });

          await withTenant(tenant.tenantId, async (tx) => {
            await recordTurn(tx, {
              sessionId,
              origin,
              visitorHash,
              locale,
              question,
              reply,
              retrievedProductIds: candidates.map((candidate) => candidate.id),
              model,
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
              latencyMs: now().getTime() - started,
            });

            await recordUsage(tx, {
              period: periodOf(now()),
              kind: CHAT_MESSAGE,
              sessionId,
              inputTokens: usage?.inputTokens ?? null,
              outputTokens: usage?.outputTokens ?? null,
              costMicros,
            });
          });

          onReport({
            outcome,
            escalations,
            model,
            candidates: candidates.length,
            preCapCount: capped.consideredCount,
            dropped,
            leaked,
            redacted: removed,
            locale,
            localeDetected: detected,
            historyDropped: recent.dropped,
            costMicros,
          });
        }
      })(),
  };
};
