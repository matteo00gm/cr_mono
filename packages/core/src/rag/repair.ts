import {
  type LlmProvider,
  type PairingChunk,
  type PairingRequest,
  type Recommendation,
} from './llm-provider.js';
import { MAX_REPLY_CHARACTERS } from './pairing-schema.js';

/**
 * One repair attempt, and then an honest answer (P2-27, §4.5).
 *
 * **Small models fail schema adherence at rates that are not negligible**, and
 * everything downstream depends on parseable output: P2-25 can only drop a
 * hallucinated id if the answer parses into ids at all. So a schema failure is
 * a normal outcome with a next step rather than an error.
 *
 * **Once, and never twice.** A model that cannot produce the schema on two
 * consecutive attempts will not produce it on the third, and the visitor is
 * waiting — the retry is worth one round trip and no more. That bound is the
 * only latency guarantee this layer can make, so it is the one it makes.
 *
 * **A failed repair degrades, it does not error.** The visitor keeps the reply
 * the model wrote and gets no cards, which is honest: a card built from
 * unvalidated output is exactly the thing P2-25 exists to prevent, and showing
 * an error for an answer that is perfectly readable would be worse service than
 * the answer.
 */

/** What became of a pairing, for `usage_events` metadata (P2-31) and §4.5's disqualification rate. */
export type PairingOutcome =
  /** The first attempt answered. */
  | 'ok'
  /** The first attempt failed the schema and the repair answered. */
  | 'repaired'
  /** Both attempts failed the schema: the reply stands, with no cards. */
  | 'schema_failed'
  /** The model declined. Not a schema problem, so not retried. */
  | 'refusal'
  /** The provider raised. Not a schema problem, so not retried. */
  | 'provider_error';

export interface SchemaRepairOptions {
  /**
   * Called exactly once, with what became of the pairing.
   *
   * A callback rather than a return value because this is a stream: the outcome
   * is known only when it ends, and a caller reading chunks cannot also be
   * waiting on a promise. P2-31 writes it to `usage_events`, which is what makes
   * the schema-failure rate measurable per provider.
   */
  readonly onOutcome?: ((outcome: PairingOutcome) => void) | undefined;
}

/** Everything a consumer of one attempt needs to decide what the next one is. */
interface Attempt {
  readonly chunks: PairingChunk[];
  readonly schemaFailed: boolean;
  readonly answered: boolean;
  readonly textEmitted: number;
}

/**
 * Runs one attempt, capping the text it is willing to pass on.
 *
 * **The cap is here rather than at the adapters** because it is a property of
 * the answer a visitor reads, and an answer can arrive in one delta or fifty.
 * `MAX_REPLY_CHARACTERS` is what the schema promises for a parsed reply, so a
 * streamed one that ran longer is a model ignoring its instructions rather than
 * a longer answer worth showing.
 */
const runAttempt = async (
  stream: AsyncIterable<PairingChunk>,
  {
    emitText,
    budget,
  }: {
    readonly emitText: boolean;
    readonly budget: number;
  },
): Promise<Attempt> => {
  const chunks: PairingChunk[] = [];
  let schemaFailed = false;
  let answered = false;
  let textEmitted = 0;
  let remaining = budget;

  for await (const chunk of stream) {
    if (chunk.type === 'error') {
      if (chunk.code === 'schema_invalid') {
        schemaFailed = true;
        break;
      }

      chunks.push(chunk);
      break;
    }

    if (chunk.type === 'recommendations') {
      answered = true;
      chunks.push(chunk);
      continue;
    }

    if (!emitText) continue;

    /*
     * The slice *is* the cap. At a remaining budget of nought it produces an
     * empty string and nothing is emitted, so an `if (remaining <= 0)` ahead of
     * it would be a guard with no failure to prevent — which P2-27's mutation
     * run said out loud by surviving it.
     */
    const delta = chunk.delta.slice(0, remaining);

    remaining -= delta.length;
    textEmitted += delta.length;

    if (delta !== '') chunks.push({ type: 'text', delta });
  }

  return { chunks, schemaFailed, answered, textEmitted };
};

const errorOutcome = (chunks: readonly PairingChunk[]): PairingOutcome | undefined => {
  for (const chunk of chunks) {
    if (chunk.type === 'error') return chunk.code === 'refusal' ? 'refusal' : 'provider_error';
  }

  return undefined;
};

/** An answer with no cards, said out loud. See P2-26 for why silence is not the same thing. */
const NO_CARDS: PairingChunk = { type: 'recommendations', items: [] as readonly Recommendation[] };

/**
 * Stream a pairing, repairing one schema failure.
 *
 * **The repair's text is suppressed when the first attempt already wrote
 * some.** Both attempts answer the same question, so letting the second one
 * through would show the visitor two replies to it. If the first attempt wrote
 * nothing — the model called its tool and produced no prose — the repair's text
 * is the only text there is, so it goes out.
 */
export const withSchemaRepair = async function* (
  provider: LlmProvider,
  request: PairingRequest,
  signal: AbortSignal,
  { onOutcome = () => undefined }: SchemaRepairOptions = {},
): AsyncIterable<PairingChunk> {
  const first = await runAttempt(provider.streamPairing(request, signal), {
    emitText: true,
    budget: MAX_REPLY_CHARACTERS,
  });

  yield* first.chunks;

  if (!first.schemaFailed) {
    onOutcome(errorOutcome(first.chunks) ?? 'ok');
    return;
  }

  /*
   * The repair gets the whole budget, and that is not a bug: it is offered the
   * budget only when the first attempt wrote nothing, so there is nothing spent
   * to subtract. Writing `MAX_REPLY_CHARACTERS - first.textEmitted` would be
   * arithmetic that is always a subtraction of nought — true today, and one
   * refactor away from being read as a guarantee it never made.
   */
  const second = await runAttempt(provider.streamPairing({ ...request, repairing: true }, signal), {
    emitText: first.textEmitted === 0,
    budget: MAX_REPLY_CHARACTERS,
  });

  yield* second.chunks;

  if (second.answered) {
    onOutcome('repaired');
    return;
  }

  const failed = errorOutcome(second.chunks);

  if (failed !== undefined) {
    onOutcome(failed);
    return;
  }

  /*
   * Both attempts failed the schema. If the model wrote a reply, the visitor
   * keeps it and is told there are no cards — degraded but honest. If it wrote
   * nothing at all there is no answer to degrade to, and that is the one case
   * where a schema failure is what the caller should see.
   */
  if (first.textEmitted + second.textEmitted === 0) {
    yield { type: 'error', code: 'schema_invalid' };
  } else {
    yield NO_CARDS;
  }

  onOutcome('schema_failed');
};
