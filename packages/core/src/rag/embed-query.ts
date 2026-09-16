import { InvalidRequestError } from '../errors.js';

import { assertBatchAligned, type EmbeddingProvider } from './embedding-provider.js';

/**
 * Embedding the visitor's message (P2-17).
 *
 * **The query has to be embedded by the model that embedded the catalogue.**
 * Cosine similarity between vectors from two different models is not small, it
 * is meaningless — and nothing fails. Retrieval returns wines, the answer reads
 * plausibly, and it is wrong in a way no error surfaces, which is why the check
 * below is a startup failure rather than a runtime one.
 */

/**
 * The most of a message that is embedded (~500 characters).
 *
 * **Truncated, never rejected.** A visitor who pastes three paragraphs asked a
 * real question, and refusing it teaches them the widget is broken. The first
 * five hundred characters carry the intent; what follows is almost always
 * context the retrieval step does not need, and paying to embed it is a bill
 * rather than a better answer.
 */
export const MAX_QUERY_CHARACTERS = 500;

/**
 * Trim, collapse runs of whitespace, and stop.
 *
 * **No stemming and no accent stripping**, deliberately. The embedding model
 * handles Italian morphology better than a regular expression can: `rosso` and
 * `rossi` are close in its space already, and stripping the accent from
 * `perché` or folding `più` throws away signal the model was trained on. Every
 * transformation here is one the model would have to undo.
 */
export const normaliseQuery = (message: string): string =>
  message.replaceAll(/\s+/gu, ' ').trim().slice(0, MAX_QUERY_CHARACTERS).trim();

export class QueryModelMismatchError extends Error {
  constructor(queryModel: string, indexedModel: string) {
    super(
      `The widget would embed a visitor's question with ${queryModel}, and the catalogue is ` +
        `indexed with ${indexedModel}. Similarity between two models' vectors is meaningless ` +
        'rather than merely worse, and nothing about it fails at runtime, so this is a boot ' +
        'failure (P2-17).',
    );
    this.name = 'QueryModelMismatchError';
  }
}

export class QueryDimensionMismatchError extends Error {
  constructor(model: string, returned: number, expected: number) {
    super(
      `${model} returned a ${String(returned)}-dimensional vector for a query, and the ` +
        `catalogue is indexed at ${String(expected)}. The comparison would be rejected by ` +
        'Postgres or, worse, silently compare the wrong thing (P2-17).',
    );
    this.name = 'QueryDimensionMismatchError';
  }
}

/** What the catalogue was indexed with, as `product_embeddings` records it. */
export interface IndexedEmbedding {
  readonly model: string;
  readonly dim: number;
}

/**
 * Refuses, at startup, a query provider that is not the one the catalogue was
 * indexed with.
 *
 * Called where the query path is constructed, so a mismatch fails the
 * deployment and the previous version keeps answering — the same placement, and
 * the same argument, as `assertProviderFitsColumn` (P1-35).
 */
export const assertQueryProviderMatchesIndex = (
  provider: EmbeddingProvider,
  indexed: IndexedEmbedding,
): EmbeddingProvider => {
  if (provider.model !== indexed.model) {
    throw new QueryModelMismatchError(provider.model, indexed.model);
  }

  if (provider.dim !== indexed.dim) {
    throw new QueryDimensionMismatchError(provider.model, provider.dim, indexed.dim);
  }

  return provider;
};

export interface QueryEmbedding {
  /** What was actually embedded, after normalisation and the cap. */
  readonly text: string;
  readonly vector: number[];
  /** The model that produced it, so a caller can record what it compared against. */
  readonly model: string;
}

/**
 * Embeds one visitor message.
 *
 * Batch-first at the seam (P1-35), one text here: the provider's own interface
 * takes an array, and a query is the one place where the batch is genuinely of
 * size one. The alignment check comes free with it.
 */
export const embedQuery = async (
  provider: EmbeddingProvider,
  message: string,
): Promise<QueryEmbedding> => {
  const text = normaliseQuery(message);

  if (text === '') {
    /*
     * Not a truncation case: there is nothing to embed. Refused here rather
     * than sent to the provider, which would charge for a vector of whitespace
     * and return something the search would happily rank wines against.
     */
    throw new InvalidRequestError('Ask a question before sending it.');
  }

  const vectors = await provider.embed([text]);
  assertBatchAligned(provider.model, [text], vectors);

  const [vector] = vectors;

  if (vector === undefined) {
    throw new Error(`${provider.model} returned no vector for a query (P2-17).`);
  }

  if (vector.length !== provider.dim) {
    throw new QueryDimensionMismatchError(provider.model, vector.length, provider.dim);
  }

  return { text, vector, model: provider.model };
};
