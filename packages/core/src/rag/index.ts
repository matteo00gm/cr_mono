/**
 * Retrieval-side domain rules (P1-33, P1-34).
 *
 * No database, no HTTP, no AWS: what a product *says* to a model, and what an
 * edit costs. The statements live in `packages/db` and the worker in
 * `apps/worker`.
 */
export {
  embeddingFields,
  embeddingText,
  EMBEDDING_TEXT_VERSION,
  priceBand,
  type EmbeddableProduct,
} from './embedding-text.js';

export { contentHashOf, shouldEmbed } from './content-hash.js';

/**
 * The embedding seam (P1-35).
 *
 * One interface, so the model behind it is a configuration choice rather than a
 * rewrite — which is what makes P1-47's bake-off possible at all.
 */
export {
  assertBatchAligned,
  assertProviderFitsColumn,
  EmbeddingDimensionMismatchError,
  type EmbeddingProvider,
} from './embedding-provider.js';

/**
 * Embedding the visitor's question (P2-17).
 *
 * The other half of the seam above: the catalogue's vectors are only comparable
 * with a query vector from the same model, and a mismatch is meaningless rather
 * than merely worse — so it is refused at startup, where a deployment can fail.
 */
export {
  assertQueryProviderMatchesIndex,
  embedQuery,
  MAX_QUERY_CHARACTERS,
  normaliseQuery,
  QueryDimensionMismatchError,
  QueryModelMismatchError,
  type IndexedEmbedding,
  type QueryEmbedding,
} from './embed-query.js';

/**
 * The embedding state machine (P1-38).
 *
 * One pure function, so an illegal transition is impossible rather than merely
 * unlikely — scattered `UPDATE ... SET embedding_state` statements are how a
 * row ends up `INDEXED` with no vector.
 */
export {
  EMBEDDING_STATES,
  GIVE_UP_AFTER,
  IllegalEmbeddingTransitionError,
  isExhausted,
  nextEmbeddingStatus,
  type EmbeddingEvent,
  type EmbeddingState,
  type EmbeddingStatus,
} from './embedding-state.js';
export * from './embedding-failure.js';

/**
 * The generation seam (P1-41).
 *
 * The interface every model adapter implements, landed before any of them so no
 * vendor's streaming format becomes the domain's.
 */
export {
  PAIRING_ERROR_CODES,
  type CandidateProduct,
  type LlmProvider,
  type PairingChunk,
  type PairingErrorCode,
  type PairingRequest,
  type Recommendation,
  type Turn,
} from './llm-provider.js';

/**
 * The structured-output schema (P2-24, pulled forward into P1).
 *
 * One Zod source every provider's format is derived from, and the validation
 * that turns a model's answer into ids P2-25 can check — or into `schema_invalid`.
 */
export {
  MAX_REASON_CHARACTERS,
  MAX_RECOMMENDATIONS,
  MAX_REPLY_CHARACTERS,
  pairingJsonSchema,
  pairingOutput,
  parsePairingOutput,
  type PairingOutput,
  type PairingParse,
} from './pairing-schema.js';

/**
 * Prompt assembly (P2-23, pulled forward into P1).
 *
 * The boundary that keeps tenant and visitor text data: instructions only in
 * the cached system prefix, every untrusted field sanitised, capped and
 * delimited so it cannot forge a delimiter of its own.
 */
export {
  buildPairingPrompt,
  FIELD_CAPS,
  InvalidCandidateIdError,
  leaksInstructions,
  MAX_HISTORY_TURNS,
  pairingSystemPrompt,
  PROMPT_MARKER,
  sanitiseUntrusted,
  type PairingPrompt,
} from './prompt.js';

/**
 * Availability and price filtering (P2-21).
 *
 * Applied to the fused list, because filtering inside a branch distorts the
 * rank sets RRF then fuses.
 */
export {
  applyFilters,
  type FilterableCandidate,
  type FilterResult,
  type RetrievalFilters,
  type StockStatus,
} from './filters.js';

/**
 * The candidate cap (P2-22).
 *
 * Cost, latency and prompt-injection surface are the same number, and the
 * pre-cap count is what §2.4 reads to tell a weak match from no match.
 */
export {
  capCandidates,
  InvalidCandidateCapError,
  MAX_CANDIDATES,
  type CappedCandidates,
} from './candidates.js';

/**
 * Output allowlisting (P2-25).
 *
 * The boundary that makes a hallucinated or cross-tenant wine structurally
 * unable to reach a visitor. If one function in this package has to be right,
 * it is this one.
 */
export { allowlisted, allowlistRecommendations, type AllowlistResult } from './allowlist.js';
