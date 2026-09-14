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
