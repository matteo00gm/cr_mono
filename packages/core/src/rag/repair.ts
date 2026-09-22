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
 *
 * **It passes chunks through as they arrive** (review fix, found by P2-29). The
 * first version collected each attempt and yielded it once the attempt ended,
 * which is not a stream: time-to-first-token became total-generation-time, and
 * a reply the model had already written was lost if the provider then failed.
 * Every case in this file's suite passed either way, because a buffered stream
 * and a streamed one produce the same chunks in the same order — the difference
 * is only *when*, and only a caller that reads them live can see it.
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

/** What one attempt turned out to be, filled in as it streams. */
interface Attempt {
  schemaFailed: boolean;
  answered: boolean;
  textEmitted: number;
  failed: PairingOutcome | undefined;
}

const fresh = (): Attempt => ({
  schemaFailed: false,
  answered: false,
  textEmitted: 0,
  failed: undefined,
});

/**
 * Streams one attempt, capping the text it is willing to pass on.
 *
 * **The cap is here rather than at the adapters** because it is a property of
 * the answer a visitor reads, and an answer can arrive in one delta or fifty.
 * `MAX_REPLY_CHARACTERS` is what the schema promises for a parsed reply, so a
 * streamed one that ran longer is a model ignoring its instructions rather than
 * a longer answer worth showing.
 *
 * **A `schema_invalid` ends the attempt without being yielded.** It is an
 * internal outcome with a next step, and rendering it would show a visitor an
 * error for an answer that is about to arrive.
 */
const runAttempt = async function* (
  stream: AsyncIterable<PairingChunk>,
  { emitText, budget }: { readonly emitText: boolean; readonly budget: number },
  attempt: Attempt,
): AsyncGenerator<PairingChunk> {
  let remaining = budget;

  for await (const chunk of stream) {
    if (chunk.type === 'error') {
      if (chunk.code === 'schema_invalid') {
        attempt.schemaFailed = true;
        return;
      }

      attempt.failed = chunk.code === 'refusal' ? 'refusal' : 'provider_error';
      yield chunk;

      return;
    }

    if (chunk.type === 'recommendations') {
      attempt.answered = true;
      yield chunk;
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
    attempt.textEmitted += delta.length;

    if (delta !== '') yield { type: 'text', delta };
  }
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
  const first = fresh();

  yield* runAttempt(
    provider.streamPairing(request, signal),
    { emitText: true, budget: MAX_REPLY_CHARACTERS },
    first,
  );

  if (!first.schemaFailed) {
    onOutcome(first.failed ?? 'ok');
    return;
  }

  const second = fresh();

  /*
   * The repair gets the whole budget, and that is not a bug: it is offered the
   * budget only when the first attempt wrote nothing, so there is nothing spent
   * to subtract. Writing `MAX_REPLY_CHARACTERS - first.textEmitted` would be
   * arithmetic that is always a subtraction of nought — true today, and one
   * refactor away from being read as a guarantee it never made.
   */
  yield* runAttempt(
    provider.streamPairing({ ...request, repairing: true }, signal),
    { emitText: first.textEmitted === 0, budget: MAX_REPLY_CHARACTERS },
    second,
  );

  if (second.answered) {
    onOutcome('repaired');
    return;
  }

  if (second.failed !== undefined) {
    onOutcome(second.failed);
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
