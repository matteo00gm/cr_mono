import {
  BedrockRuntimeClient,
  InvokeModelCommand,
  type BedrockRuntimeClientConfig,
} from '@aws-sdk/client-bedrock-runtime';
import {
  assertBatchAligned,
  EMBEDDING_TEXT_VERSION,
  type EmbeddingProvider,
} from '@catalogorosso/core';

/**
 * Titan Text Embeddings V2, behind the P1-35 port (P1-36).
 *
 * **In `apps/worker` rather than `packages/core`, where the row puts it.** The
 * P0-09 boundary rule forbids `core` importing the AWS SDK, and the reason is
 * exactly the one that applies here: the moment it does, testing anything in
 * that package needs a mocked cloud, and the suites that are fast and trusted
 * stop being either. The *port* stays in core, which is what every other module
 * compiles against; the adapter lives beside its only consumer.
 */

/** §5.3's choice, and the string written to `product_embeddings.model`. */
export const TITAN_MODEL = 'amazon.titan-embed-text-v2:0';

/**
 * 1024, matching `halfvec(1024)` — and asserted against the column at startup
 * by `assertProviderFitsColumn`, because a mismatch that reached the database
 * would look like a wave of embedding failures rather than one wrong number.
 */
export const TITAN_DIMENSIONS = 1024;

/**
 * Titan's documented input ceiling is 8,192 tokens.
 *
 * **Budgeted in characters, because tokens are the model's unit and there is no
 * tokeniser here** — pulling one in to count exactly would be a dependency, and
 * a version of it to keep aligned with a remote model. Four characters per
 * token is the conventional ratio for Latin scripts and is deliberately
 * conservative for Italian, whose longer words push the true ratio higher. The
 * cost of being conservative is a slightly shorter tail on a very long tasting
 * note; the cost of being wrong the other way is a rejected call that the retry
 * loop then repeats.
 */
const MAX_CHARACTERS = 8_192 * 4;

/**
 * How many calls are in flight at once.
 *
 * **Titan embeds one text per call**, so `embed(texts)` is a fan-out rather
 * than a batch — the batch-first signature (P1-35) exists precisely so this
 * loop lives in one place instead of in every caller. Five is chosen against
 * the same arithmetic as P1-32's worker concurrency: the worker is already
 * capped at five concurrent invocations, so this is five requests in flight per
 * invocation rather than five hundred.
 */
const CONCURRENCY = 5;

/** Bedrock's throttling and transient server errors, by name. */
const RETRYABLE = new Set([
  'ThrottlingException',
  'TooManyRequestsException',
  'ServiceUnavailableException',
  'ModelTimeoutException',
  'InternalServerException',
]);

export interface TitanOptions {
  readonly client?: BedrockRuntimeClient | undefined;
  readonly config?: BedrockRuntimeClientConfig | undefined;
  /** Injected so the backoff is testable without waiting for it. */
  readonly sleep?: ((ms: number) => Promise<void>) | undefined;
  /** Injected so the jitter is testable at all. */
  readonly random?: (() => number) | undefined;
  /** Raised when an input had to be shortened, for the P1-50 triage. */
  readonly onTruncate?:
    ((info: { readonly from: number; readonly to: number }) => void) | undefined;
  readonly maxAttempts?: number | undefined;
}

/**
 * Shortens an input at a sentence boundary, not mid-word.
 *
 * **A hard cut mid-sentence is worse than a shorter document.** It can end on a
 * fragment that inverts the clause before it — a note ending "non adatto a"
 * says the opposite of what the seller wrote. Falling back to a whitespace
 * boundary, and only then to a hard cut, keeps that from happening for any
 * realistic tasting note.
 *
 * Logged rather than silent, because an input this long usually means somebody
 * pasted a whole page into a field, and the seller is the only person who can
 * fix that.
 */
export const truncateForTitan = (
  text: string,
  onTruncate?: (info: { readonly from: number; readonly to: number }) => void,
): string => {
  if (text.length <= MAX_CHARACTERS) return text;

  const window = text.slice(0, MAX_CHARACTERS);
  const sentenceEnd = Math.max(
    window.lastIndexOf('. '),
    window.lastIndexOf('.\n'),
    window.lastIndexOf('! '),
    window.lastIndexOf('? '),
  );

  /*
   * **`Math.max` here was a bug the test caught**: an index is always smaller
   * than the length, so it picked the hard cut every time and the word-boundary
   * fallback never ran. The ladder says what was meant — a sentence if there is
   * one late enough to be worth keeping, otherwise a word, otherwise a hard cut
   * for input with no whitespace in it at all.
   */
  const space = window.lastIndexOf(' ');
  const half = MAX_CHARACTERS / 2;

  const cut = sentenceEnd > half ? sentenceEnd + 1 : space > half ? space : MAX_CHARACTERS;

  onTruncate?.({ from: text.length, to: cut });

  return window.slice(0, cut).trimEnd();
};

const isRetryable = (error: unknown): boolean => {
  const name = (error as { name?: unknown } | undefined)?.name;
  return typeof name === 'string' && RETRYABLE.has(name);
};

/**
 * Full jitter, which is what the injected random source is for.
 *
 * The calls that hit the cap arrive together — a bulk import fans out five at a
 * time from every worker — and a batch that all backs off by the same interval
 * retries in lockstep and hits the limit again. Same reasoning as P0-64's email
 * backoff, for the same reason.
 */
const backoffMs = (attempt: number, random: () => number): number =>
  Math.floor(random() * Math.min(200 * 2 ** attempt, 5_000));

export const titanEmbeddingProvider = (options: TitanOptions = {}): EmbeddingProvider => {
  const client = options.client ?? new BedrockRuntimeClient(options.config ?? {});
  const sleep =
    options.sleep ??
    ((ms: number) =>
      new Promise<void>((resolve) => {
        setTimeout(resolve, ms);
      }));
  const random = options.random ?? Math.random;
  const maxAttempts = options.maxAttempts ?? 4;

  const embedOne = async (text: string): Promise<number[]> => {
    const body = JSON.stringify({
      inputText: truncateForTitan(text, options.onTruncate),
      dimensions: TITAN_DIMENSIONS,
      /*
       * **`normalize: true` is not a formatting preference.** Normalised
       * vectors make cosine distance equivalent to inner product and keep
       * magnitudes consistent across rows, so a long tasting note does not
       * outrank a short one for having more words in it. pgvector's `<=>` is
       * cosine distance, and mixing normalised and unnormalised vectors in one
       * index gives answers that are wrong in a way nothing reports.
       */
      normalize: true,
    });

    for (let attempt = 0; ; attempt += 1) {
      try {
        const response = await client.send(
          new InvokeModelCommand({
            modelId: TITAN_MODEL,
            contentType: 'application/json',
            accept: 'application/json',
            body,
          }),
        );

        const parsed = JSON.parse(new TextDecoder().decode(response.body)) as {
          embedding?: unknown;
        };

        if (!Array.isArray(parsed.embedding)) {
          throw new Error(`${TITAN_MODEL} returned no embedding for a text it accepted`);
        }

        return parsed.embedding as number[];
      } catch (error) {
        /*
         * Only throttling and transient server errors are retried. A validation
         * error is ours to fix, and repeating it turns one mistake into four
         * before landing the message in the DLQ looking like a provider problem
         * — which is precisely the confusion P1-50 exists to resolve.
         */
        if (attempt + 1 >= maxAttempts || !isRetryable(error)) throw error;

        await sleep(backoffMs(attempt, random));
      }
    }
  };

  return {
    model: TITAN_MODEL,
    dim: TITAN_DIMENSIONS,

    async embed(texts) {
      const vectors: number[][] = new Array<number[]>(texts.length);

      /*
       * A fixed pool rather than `Promise.all` over everything: a bulk import
       * hands this a hundred texts, and a hundred simultaneous Bedrock calls is
       * how one worker throttles itself and every other worker at the same
       * time. Each runner takes the next index, so a slow call does not stall a
       * whole slice the way a chunked `Promise.all` would.
       */
      let next = 0;
      const runner = async (): Promise<void> => {
        for (;;) {
          const index = next;
          next += 1;
          if (index >= texts.length) return;

          const text = texts[index];
          if (text === undefined) return;

          vectors[index] = await embedOne(text);
        }
      };

      await Promise.all(Array.from({ length: Math.min(CONCURRENCY, texts.length) }, runner));

      assertBatchAligned(TITAN_MODEL, texts, vectors);

      return vectors;
    },
  };
};

/**
 * What the vectors were built from, for the record.
 *
 * The model alone does not identify a vector: the same model over a different
 * *text* produces a different embedding, which is what `EMBEDDING_TEXT_VERSION`
 * exists to make visible (P1-33). Exported so P1-49's affordance has both
 * halves to show.
 */
export const TITAN_PROVENANCE = `${TITAN_MODEL}/${EMBEDDING_TEXT_VERSION}`;
