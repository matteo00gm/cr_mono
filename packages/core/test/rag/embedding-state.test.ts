import { describe, expect, it } from 'vitest';

import {
  GIVE_UP_AFTER,
  IllegalEmbeddingTransitionError,
  isExhausted,
  nextEmbeddingStatus,
  type EmbeddingState,
  type EmbeddingStatus,
} from '../../src/rag/embedding-state.js';

/**
 * The embedding state machine (P1-38).
 *
 * **What this file is really testing is that a state cannot lie.** A state is
 * just a word in a column: nothing about `INDEXED` prevents a row from having
 * no vector, and nothing about `FAILED` prevents it from having one. Scattered
 * `UPDATE ... SET embedding_state` statements are how both happen, and neither
 * is visible from the row.
 */

const at = (state: EmbeddingState, over: Partial<EmbeddingStatus> = {}): EmbeddingStatus => ({
  state,
  error: null,
  attempts: 0,
  ...over,
});

describe('the ordinary life of a wine', () => {
  it('is created pending, embedded, edited, queued and embedded again', () => {
    /*
     * The whole cycle in one test, because the interesting property is that the
     * cycle *closes* — a wine that has been through it once is in the same
     * state as one that has not, so nothing accumulates.
     */
    let status = nextEmbeddingStatus({ status: at('PENDING'), event: 'created' });
    expect(status.state).toBe('PENDING');

    status = nextEmbeddingStatus({ status, event: 'embedded' });
    expect(status.state).toBe('INDEXED');

    status = nextEmbeddingStatus({ status, event: 'edited' });
    expect(status.state).toBe('STALE');

    status = nextEmbeddingStatus({ status, event: 'queued' });
    expect(status.state).toBe('PENDING');

    status = nextEmbeddingStatus({ status, event: 'embedded' });
    expect(status).toEqual({ state: 'INDEXED', error: null, attempts: 0 });
  });
});

describe('STALE, which is the state that carries meaning', () => {
  it('is where an edit puts a wine that already had an embedding', () => {
    /*
     * `PENDING` means never indexed and not recommendable yet; `STALE` means
     * findable under its previous description while the new one is built.
     * P1-40's grid shows a seller that difference, and collapsing them would
     * tell somebody their catalogue had gone dark during an ordinary edit.
     */
    expect(nextEmbeddingStatus({ status: at('INDEXED'), event: 'edited' }).state).toBe('STALE');
  });

  it('is not where an edit puts a wine that never had one', () => {
    expect(nextEmbeddingStatus({ status: at('PENDING'), event: 'edited' }).state).toBe('PENDING');
  });

  it('returns a failed wine to pending, because the edit may be the fix', () => {
    expect(nextEmbeddingStatus({ status: at('FAILED'), event: 'edited' }).state).toBe('PENDING');
  });
});

describe('redelivery', () => {
  it('makes queueing an already-pending wine a no-op', () => {
    /*
     * SQS redelivers, and the poller can publish the same job twice. Neither
     * must move a wine backwards or forwards — a transition that only works
     * once is a transition that breaks the day something is retried.
     */
    const status = at('PENDING');

    expect(nextEmbeddingStatus({ status, event: 'queued' })).toEqual(status);
  });

  it('makes embedding an already-indexed wine a no-op', () => {
    const status = at('INDEXED');

    expect(nextEmbeddingStatus({ status, event: 'embedded' })).toEqual(status);
  });
});

describe('failure', () => {
  it('records the provider words and counts the attempt', () => {
    const status = nextEmbeddingStatus({
      status: at('PENDING'),
      event: 'failed',
      error: 'ThrottlingException',
    });

    expect(status).toEqual({ state: 'FAILED', error: 'ThrottlingException', attempts: 1 });
  });

  it('refuses to record a failure with no reason', () => {
    /*
     * **A `FAILED` row with no reason is the worst of both**: it reports a
     * problem and withholds the only thing that would let anyone act on it.
     * Refusing at the call site is what keeps that out of the column.
     */
    expect(() => nextEmbeddingStatus({ status: at('PENDING'), event: 'failed' })).toThrow(
      IllegalEmbeddingTransitionError,
    );

    expect(() =>
      nextEmbeddingStatus({ status: at('PENDING'), event: 'failed', error: '   ' }),
    ).toThrow(IllegalEmbeddingTransitionError);
  });

  it('accumulates attempts across failures', () => {
    let status = at('PENDING');

    for (let attempt = 0; attempt < 3; attempt += 1) {
      status = nextEmbeddingStatus({ status, event: 'failed', error: 'boom' });
    }

    expect(status.attempts).toBe(3);
  });
});

describe('the error text', () => {
  it('is cleared on success', () => {
    /*
     * **Not tidiness.** A row that is `INDEXED` while still carrying last
     * week's failure tells an operator a wine is broken when it is not — and
     * P1-50's triage reads that column to decide what to look at, so a stale
     * error is worse than none.
     */
    const failed = nextEmbeddingStatus({ status: at('PENDING'), event: 'failed', error: 'boom' });
    const fixed = nextEmbeddingStatus({ status: failed, event: 'embedded' });

    expect(fixed.error).toBeNull();
  });

  it('survives success in the attempt count, which is the opposite decision', () => {
    /*
     * A wine that needed four tries is worth knowing about even after it
     * succeeds: four tries usually means a text the provider keeps struggling
     * with rather than four unlucky moments.
     */
    const failed = nextEmbeddingStatus({ status: at('PENDING'), event: 'failed', error: 'boom' });
    const fixed = nextEmbeddingStatus({ status: failed, event: 'embedded' });

    expect(fixed.attempts).toBe(1);
  });

  it('refuses an error passed alongside a success', () => {
    /*
     * A caller that has confused two paths. Writing it would produce exactly
     * the stale-error row the clearing above exists to prevent.
     */
    expect(() =>
      nextEmbeddingStatus({ status: at('PENDING'), event: 'embedded', error: 'boom' }),
    ).toThrow(IllegalEmbeddingTransitionError);
  });
});

describe('every edge is defined', () => {
  it.each(['PENDING', 'INDEXED', 'FAILED', 'STALE'] as const)(
    'has a destination for every event from %s',
    (state) => {
      /*
       * Exhaustive rather than illustrative: a missing edge would be
       * `undefined` written into a NOT NULL enum column, which fails at the
       * database rather than here — a long way from the caller that caused it.
       */
      for (const event of ['created', 'edited', 'queued', 'embedded'] as const) {
        expect(nextEmbeddingStatus({ status: at(state), event }).state).toBeTruthy();
      }

      expect(nextEmbeddingStatus({ status: at(state), event: 'failed', error: 'x' }).state).toBe(
        'FAILED',
      );
    },
  );
});

describe('isExhausted', () => {
  it('is false while there are attempts left', () => {
    expect(isExhausted(at('FAILED', { attempts: GIVE_UP_AFTER - 1 }))).toBe(false);
  });

  it('is true once a wine has been given up on', () => {
    expect(isExhausted(at('FAILED', { attempts: GIVE_UP_AFTER }))).toBe(true);
  });

  it('is false for a wine that is not failing, however many attempts it took', () => {
    /*
     * The threshold is about *current* trouble. A wine that needed five tries
     * and then succeeded is not exhausted; it is indexed.
     */
    expect(isExhausted(at('INDEXED', { attempts: GIVE_UP_AFTER + 3 }))).toBe(false);
  });
});
