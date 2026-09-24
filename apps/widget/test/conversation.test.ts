import { describe, expect, it } from 'vitest';

import {
  apply,
  asked,
  empty,
  isEmptyAnswer,
  lastQuestion,
  retried,
  stopped,
  type Conversation,
} from '../src/conversation.js';

/**
 * What a visitor has read (P3-06).
 *
 * **The property this file exists for is in the last block.** "A failure
 * mid-stream shows a retry and preserves history" is the row's own wording, and
 * it is the kind of promise a component test can appear to keep while the state
 * underneath has quietly thrown the conversation away.
 */

const answer = (text: string): Conversation =>
  apply(asked(empty, 'Che vino?'), { type: 'text', delta: text });

const ITEMS = [{ productId: 'p1', reason: 'tannino deciso', confidence: 0.9 }];

describe('asking', () => {
  it('adds the question and an empty answer to write into', () => {
    expect(asked(empty, 'Che vino?').turns).toEqual([
      { role: 'visitor', text: 'Che vino?', recommendations: [] },
      { role: 'sommelier', text: '', recommendations: [] },
    ]);
  });

  it('is streaming from the moment the question is asked', () => {
    expect(asked(empty, 'Che vino?').streaming).toBe(true);
  });

  it('clears the previous failure, because asking again is the retry', () => {
    const failed = stopped(answer('Un '), { k: 'error', cause: 'network' });

    expect(asked(failed, 'Ancora?').failure).toBeUndefined();
  });

  it('keeps every earlier turn', () => {
    expect(asked(answer('Un Barolo.'), 'E con il pesce?').turns).toHaveLength(4);
  });
});

describe('applying events', () => {
  it('appends deltas in order', () => {
    const events = ['Un ', 'Barolo', ' del 2016.'];
    const conversation = events.reduce(
      (current, delta) => apply(current, { type: 'text', delta }),
      asked(empty, 'Che vino?'),
    );

    expect(conversation.turns.at(-1)?.text).toBe('Un Barolo del 2016.');
  });

  it('attaches recommendations to the answer being written', () => {
    const conversation = apply(answer('Un Barolo.'), { type: 'recommendations', items: ITEMS });

    expect(conversation.turns.at(-1)?.recommendations).toEqual(ITEMS);
  });

  it('stops streaming when the stream says it is done', () => {
    expect(apply(answer('Un Barolo.'), { type: 'done' }).streaming).toBe(false);
  });

  it('leaves the answer alone when the stream ends', () => {
    // Nothing to do with failure: the text read so far is the answer.
    expect(apply(answer('Un Barolo.'), { type: 'done' }).turns.at(-1)?.text).toBe('Un Barolo.');
  });

  it('ignores an event that arrives before any question', () => {
    /*
     * The server does not do this, and a reducer that wrote into `turns[-1]`
     * anyway would either throw or invent a turn nobody asked for.
     */
    expect(apply(empty, { type: 'text', delta: 'Un ' })).toEqual(empty);
  });

  it('ignores a delta that arrives after the answer is closed', () => {
    const closed: Conversation = {
      turns: [{ role: 'visitor', text: 'Che vino?', recommendations: [] }],
      streaming: false,
      failure: undefined,
    };

    expect(apply(closed, { type: 'text', delta: 'Un ' })).toEqual(closed);
  });

  it('tells a spent month apart from a shop that is busy', () => {
    // The visitor is told something different, and offered something different.
    const provider = { k: 'error', cause: 'provider' };

    expect(apply(answer('Un '), { type: 'error', code: 'quota_exceeded' }).failure).toEqual({
      k: 'quota',
    });
    expect(apply(answer('Un '), { type: 'error', code: 'provider_error' }).failure).toEqual(
      provider,
    );
    expect(apply(answer('Un '), { type: 'error', code: 'refusal' }).failure).toEqual(provider);
    expect(apply(answer('Un '), { type: 'error', code: 'schema_invalid' }).failure).toEqual(
      provider,
    );
  });
});

describe('an error preserves the conversation', () => {
  /*
   * **The row is explicit about this.** A visitor who has read three paragraphs
   * and lost the fourth has still read three, and discarding them to render an
   * error state is the widget punishing them for our outage.
   */
  const read = apply(
    apply(answer('Un Barolo del 2016. '), { type: 'recommendations', items: ITEMS }),
    { type: 'text', delta: 'Si abbina' },
  );
  const failed = apply(read, { type: 'error', code: 'provider_error' });

  it('keeps every turn, including the half-written one', () => {
    expect(failed.turns).toEqual(read.turns);
  });

  it('keeps the partial answer rather than blanking it', () => {
    expect(failed.turns.at(-1)?.text).toBe('Un Barolo del 2016. Si abbina');
  });

  it('keeps the cards that already arrived', () => {
    expect(failed.turns.at(-1)?.recommendations).toEqual(ITEMS);
  });

  it('stops streaming, so the composer comes back', () => {
    expect(failed.streaming).toBe(false);
  });

  it('says why, so the notice can say the right thing', () => {
    expect(failed.failure).toEqual({ k: 'error', cause: 'provider' });
  });
});

describe('stopping for a reason the stream never gave', () => {
  it('records a refusal before the first event', () => {
    expect(stopped(asked(empty, 'Che vino?'), { k: 'error', cause: 'provider' })).toMatchObject({
      streaming: false,
      failure: { k: 'error', cause: 'provider' },
    });
  });

  it('keeps what was read when the connection goes away mid-answer', () => {
    expect(stopped(answer('Un Bar'), { k: 'error', cause: 'network' }).turns.at(-1)?.text).toBe(
      'Un Bar',
    );
  });
});

describe('retrying', () => {
  const failed = apply(answer('Un Barolo, '), { type: 'error', code: 'provider_error' });

  it('knows which question to send again', () => {
    expect(lastQuestion(failed)).toBe('Che vino?');
  });

  it('has nothing to send again before a question is asked', () => {
    // A retry button that resends the empty string is worse than no button.
    expect(lastQuestion(empty)).toBeUndefined();
  });

  it('reads the last question, not the first', () => {
    expect(lastQuestion(asked(answer('Un Barolo.'), 'E con il pesce?'))).toBe('E con il pesce?');
  });

  it('clears the failed answer, because the model starts over', () => {
    /*
     * Keeping the half-written reply would show the first paragraph twice: the
     * retry is a new generation, not a resumption.
     */
    expect(retried(failed).turns.at(-1)).toEqual({
      role: 'sommelier',
      text: '',
      recommendations: [],
    });
  });

  it('keeps the turns above the one that failed', () => {
    const second = apply(asked(answer('Un Barolo.'), 'E con il pesce?'), {
      type: 'error',
      code: 'provider_error',
    });

    expect(retried(second).turns.slice(0, 2)).toEqual([
      { role: 'visitor', text: 'Che vino?', recommendations: [] },
      { role: 'sommelier', text: 'Un Barolo.', recommendations: [] },
    ]);
  });

  it('is streaming again, with the notice cleared', () => {
    expect(retried(failed)).toMatchObject({ streaming: true, failure: undefined });
  });

  it('drops the cards from the failed answer too', () => {
    const withCards = apply(failed, { type: 'recommendations', items: ITEMS });

    expect(retried(withCards).turns.at(-1)?.recommendations).toEqual([]);
  });
});

describe('an answer with nothing in it yet', () => {
  it('is empty before the first delta', () => {
    const turn = asked(empty, 'Che vino?').turns.at(-1);

    expect(turn !== undefined && isEmptyAnswer(turn)).toBe(true);
  });

  it('is not empty once a delta arrives', () => {
    const turn = answer('U').turns.at(-1);

    expect(turn !== undefined && isEmptyAnswer(turn)).toBe(false);
  });

  it('is not empty when only cards arrived', () => {
    const turn = apply(asked(empty, 'Che vino?'), {
      type: 'recommendations',
      items: ITEMS,
    }).turns.at(-1);

    expect(turn !== undefined && isEmptyAnswer(turn)).toBe(false);
  });

  it('is never true of the visitor, whose own words are never hidden', () => {
    expect(isEmptyAnswer({ role: 'visitor', text: '', recommendations: [] })).toBe(false);
  });
});
