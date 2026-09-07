/**
 * Catalogue domain rules (P1-02 onward).
 *
 * No database and no HTTP: what a product *is*, and what about it costs money
 * to change. The statements live in `packages/db` and the routes in `apps/api`.
 */
export {
  contentHashOf,
  embeddingFields,
  EMBEDDING_TEXT_VERSION,
  type EmbeddableProduct,
} from './content-hash.js';
