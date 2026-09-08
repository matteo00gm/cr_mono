/**
 * Where a wine sits in the embedding pipeline, as a machine (P1-38).
 *
 * **The transitions live in one pure function so an illegal one is impossible
 * rather than merely unlikely.** Scattered `UPDATE ... SET embedding_state`
 * statements are how a row ends up `INDEXED` with no vector, or `FAILED` after
 * a success — and neither is visible from the row itself, because a state is
 * just a word. P1-02, P1-03 and P1-04 already write three of these edges
 * between them; this is what stops the fourth author inventing a fifth.
 */

export const EMBEDDING_STATES = ['PENDING', 'INDEXED', 'FAILED', 'STALE'] as const;
export type EmbeddingState = (typeof EMBEDDING_STATES)[number];

/**
 * What can happen to a wine, named for the event rather than the destination.
 *
 * **Events, not target states**, and that is the point of the design: a caller
 * saying "set it to INDEXED" is asserting a conclusion, where a caller saying
 * "embedded" is reporting what happened and letting this decide what it means.
 * The second cannot lie about a wine it never embedded.
 */
export type EmbeddingEvent = 'created' | 'edited' | 'queued' | 'embedded' | 'failed';

export interface EmbeddingStatus {
  readonly state: EmbeddingState;
  /** The provider's own words. Cleared on success — see below. */
  readonly error: string | null;
  /** How many times the *provider* refused. Not the outbox's publish count. */
  readonly attempts: number;
}

export class IllegalEmbeddingTransitionError extends Error {
  constructor(from: EmbeddingState, event: EmbeddingEvent) {
    super(
      `A wine that is ${from} cannot be "${event}". This is a bug in the caller rather ` +
        'than a state a database can be in, so it throws instead of writing something ' +
        'plausible (P1-38).',
    );
    this.name = 'IllegalEmbeddingTransitionError';
  }
}

/**
 * The legal edges, written out.
 *
 * - **`created`** puts a new wine at `PENDING`, which is where P1-02's insert
 *   already puts it.
 * - **`edited`** only matters for a wine that *had* an embedding: `INDEXED →
 *   STALE` says "findable under its previous description while the new one is
 *   built", which is the distinction P1-40's grid shows a seller. An edit to a
 *   wine that is still `PENDING` changes nothing, because it is already going
 *   to be embedded — and an edit to a `FAILED` one returns it to `PENDING`,
 *   since the edit may well be the fix.
 * - **`queued`** is the poller publishing the job. It moves `STALE → PENDING`;
 *   from `PENDING` it is a no-op, which is what makes a redelivered message
 *   harmless.
 * - **`embedded`** and **`failed`** are the worker reporting an outcome, and
 *   both are legal from any state a job could have been queued in.
 *
 * `INDEXED` is deliberately *not* reachable from `INDEXED` by `edited`: an edit
 * that changed nothing the model reads never reaches this function at all,
 * because P1-03 does not enqueue one.
 */
const EDGES: Readonly<Record<EmbeddingEvent, Readonly<Record<EmbeddingState, EmbeddingState>>>> = {
  created: { PENDING: 'PENDING', INDEXED: 'PENDING', FAILED: 'PENDING', STALE: 'PENDING' },
  edited: { PENDING: 'PENDING', INDEXED: 'STALE', FAILED: 'PENDING', STALE: 'STALE' },
  queued: { PENDING: 'PENDING', INDEXED: 'STALE', FAILED: 'PENDING', STALE: 'PENDING' },
  embedded: { PENDING: 'INDEXED', INDEXED: 'INDEXED', FAILED: 'INDEXED', STALE: 'INDEXED' },
  failed: { PENDING: 'FAILED', INDEXED: 'FAILED', FAILED: 'FAILED', STALE: 'FAILED' },
};

export interface TransitionInput {
  readonly status: EmbeddingStatus;
  readonly event: EmbeddingEvent;
  /** Required by `failed`, refused by everything else. */
  readonly error?: string | undefined;
}

/**
 * The next status, or a throw.
 *
 * **The error text is cleared on success, and that is not tidiness.** A row
 * that is `INDEXED` while still carrying the reason it failed last week tells
 * an operator a wine is broken when it is not — and P1-50's triage reads that
 * column to decide what to look at. So a stale error is worse than none.
 *
 * **The attempt counter is *not* cleared**, for the opposite reason: a wine
 * that needed four tries is a wine worth knowing about even after it succeeds,
 * because four tries usually means a text the provider keeps struggling with
 * rather than four unlucky moments.
 */
export const nextEmbeddingStatus = ({ status, event, error }: TransitionInput): EmbeddingStatus => {
  const state = EDGES[event][status.state];

  if (event === 'failed') {
    if (error === undefined || error.trim() === '') {
      /*
       * A `FAILED` row with no reason is the worst of both: it reports a
       * problem and withholds the only thing that would let anyone act on it.
       * Refusing at the call site is what stops that reaching the column.
       */
      throw new IllegalEmbeddingTransitionError(status.state, event);
    }

    return { state, error, attempts: status.attempts + 1 };
  }

  if (error !== undefined) {
    /*
     * An error passed alongside a success is a caller that has confused two
     * paths, and writing it would produce exactly the stale-error row the
     * clearing above exists to prevent.
     */
    throw new IllegalEmbeddingTransitionError(status.state, event);
  }

  return { state, error: null, attempts: status.attempts };
};

/**
 * Whether a wine has been given up on.
 *
 * Read by P1-50's triage rather than enforced here: the *state machine* has no
 * opinion about how many failures is too many, and baking a threshold into it
 * would make changing that number a change to the transitions.
 */
export const GIVE_UP_AFTER = 5;

export const isExhausted = (status: EmbeddingStatus): boolean =>
  status.state === 'FAILED' && status.attempts >= GIVE_UP_AFTER;
