import type { EmbeddableProduct } from './embedding-text.js';

/**
 * The generation seam (P1-41, §4.5).
 *
 * **The interface alone, before any adapter.** Landing it first is what stops
 * the first vendor's SDK shape from leaking into the domain: an interface
 * written after an adapter tends to describe that adapter. Everything here is
 * ours — a request, a stream of chunks, three error codes — and each adapter
 * translates its vendor's streaming format into these, not the other way round.
 *
 * `llm-provider.test.ts` holds this file to importing nothing but core's own
 * types, so a vendor type cannot arrive by way of a convenient re-export.
 */

/** A wine the model may recommend, as retrieval hands it over. */
export interface CandidateProduct extends EmbeddableProduct {
  /**
   * The id a recommendation has to name.
   *
   * Only these ids can reach a visitor: P2-25 drops any recommendation whose
   * id was not among this request's candidates, which is what makes a
   * hallucinated or cross-tenant wine structurally unable to appear.
   */
  readonly id: string;
}

/**
 * One earlier message in the conversation.
 *
 * No `system` role: the instructions are the adapter's to place, at the front of
 * the stable prefix that prompt caching depends on (§4.5). A system message
 * arriving through history would be visitor-controlled text wearing the
 * authority of an instruction.
 */
export interface Turn {
  readonly role: 'user' | 'assistant';
  readonly content: string;
}

export interface PairingRequest {
  /** The visitor's message, as they wrote it. Untrusted. */
  readonly query: string;
  /** BCP 47 — `it` for nearly every visitor. The reply is written in it. */
  readonly locale: string;
  readonly candidates: readonly CandidateProduct[];
  readonly history: readonly Turn[];
  /**
   * This is the second attempt, after one that did not match the schema (P2-27).
   *
   * **A flag rather than a repaired prompt**, because the repair instruction is
   * an operator instruction and §3.7 puts those in the system position only.
   * Interpolating one into a user turn would place it exactly where retrieved
   * text sits, which is the arrangement P2-23 exists to prevent — and it would
   * be a model's own failure teaching it where instructions can appear.
   */
  readonly repairing?: boolean | undefined;
}

/**
 * One recommended wine and the reason a visitor will read.
 *
 * The shape P2-24's structured-output schema validates. The reason is what the
 * visitor sees, so a defensible wine with a wrong reason is still a wrong
 * answer (P1-46's rubric).
 */
export interface Recommendation {
  readonly productId: string;
  readonly reason: string;
  readonly confidence: number;
}

/**
 * The ways a pairing can fail that a caller has to handle.
 *
 * - `schema_invalid` — the model's structured output did not validate. P2-27
 *   retries once with a repair prompt, then answers with text and no cards.
 * - `refusal` — the model declined. Arrives as a successful response from some
 *   providers, so an adapter has to look for it rather than wait for an error.
 * - `provider_error` — throttling, timeouts, anything the provider raised.
 */
export const PAIRING_ERROR_CODES = ['schema_invalid', 'refusal', 'provider_error'] as const;

export type PairingErrorCode = (typeof PAIRING_ERROR_CODES)[number];

/**
 * What a provider streams.
 *
 * **A failure is a chunk, not an exception.** Schema failure is an expected
 * outcome at a measurable rate (§4.5), and a caller that has to catch it cannot
 * also have received the text streamed before it — which is exactly what the
 * P2-27 fallback shows the visitor.
 */
export type PairingChunk =
  | { readonly type: 'text'; readonly delta: string }
  | { readonly type: 'recommendations'; readonly items: readonly Recommendation[] }
  | { readonly type: 'error'; readonly code: PairingErrorCode };

export interface LlmProvider {
  /** Stable, for logs, `usage_events` and the P1-47 table: `bedrock-nova-lite`, not a display name. */
  readonly id: string;

  /**
   * Streams a pairing for one request.
   *
   * **The signal is required, not optional.** A visitor who closes the widget
   * mid-answer must stop the generation, or every abandoned conversation is
   * billed to its last token. An optional signal is the one nobody passes.
   */
  streamPairing(request: PairingRequest, signal: AbortSignal): AsyncIterable<PairingChunk>;
}
