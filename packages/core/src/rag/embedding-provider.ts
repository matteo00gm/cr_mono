/**
 * The embedding seam (P1-35).
 *
 * One interface, so the model behind it is a configuration choice rather than a
 * rewrite — the same reason `LlmProvider` exists (P1-41) and the same reason
 * the transport in P0-64 is a port. What that buys concretely is P1-47's
 * bake-off: comparing two providers has to be possible without touching the
 * worker.
 */

export interface EmbeddingProvider {
  /**
   * The provider's own model identifier, stored on every vector.
   *
   * Written to `product_embeddings.model` because the useful question after a
   * model change is "which rows are still on the old one", and a column that
   * only says *when* a row was written cannot answer it (P0-27).
   */
  readonly model: string;

  /** How many numbers a vector has. Asserted against the column — see below. */
  readonly dim: number;

  /**
   * **Batch-first, and the signature is the decision.** Every provider worth
   * using is markedly cheaper and faster batched, and a single-text signature
   * pushes the batching into each caller — where one of them will forget, and
   * the symptom is a bill rather than a failure. A provider that can only embed
   * one text at a time implements this by looping internally, which is where
   * the loop belongs.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

export class EmbeddingDimensionMismatchError extends Error {
  constructor(model: string, providerDim: number, columnDim: number) {
    super(
      `The embedding provider ${model} returns ${String(providerDim)}-dimensional vectors, ` +
        `and product_embeddings.embedding is halfvec(${String(columnDim)}). ` +
        'Storing one in the other is refused by Postgres on every insert, so this is a ' +
        'boot failure rather than a runtime surprise (P1-35).',
    );
    this.name = 'EmbeddingDimensionMismatchError';
  }
}

/**
 * Refuses a provider whose vectors do not fit the column.
 *
 * **A boot failure, and that placement is the whole point of the check.** The
 * alternative is a worker that starts healthy, drains the queue, and fails
 * every insert with a Postgres type error — which surfaces as a DLQ full of
 * products that look like embedding failures (P1-50's triage) rather than as
 * one configuration mistake. Failing at startup means the deployment fails and
 * the previous version keeps working.
 *
 * Called at construction rather than per invocation, so the cost is one
 * comparison per container.
 */
export const assertProviderFitsColumn = (
  provider: EmbeddingProvider,
  columnDimensions: number,
): EmbeddingProvider => {
  if (provider.dim !== columnDimensions) {
    throw new EmbeddingDimensionMismatchError(provider.model, provider.dim, columnDimensions);
  }

  return provider;
};

/**
 * Refuses a response that is not shaped like the request.
 *
 * **Every provider promises this and the check is still worth its five lines**,
 * because the failure mode is silent misalignment rather than an error: a
 * response one element short pairs every vector after the gap with the wrong
 * product, and the result is a catalogue where each wine is described by its
 * neighbour. Nothing throws, retrieval works, and the answers are quietly
 * wrong — the hardest kind of bug to attribute months later.
 */
export const assertBatchAligned = (
  model: string,
  texts: readonly string[],
  vectors: readonly number[][],
): void => {
  if (vectors.length !== texts.length) {
    throw new Error(
      `The embedding provider ${model} returned ${String(vectors.length)} vectors for ` +
        `${String(texts.length)} texts. A short batch would pair vectors with the wrong ` +
        'products, so it is refused rather than trimmed.',
    );
  }
};
