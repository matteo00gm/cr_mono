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
