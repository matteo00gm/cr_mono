import { describe, expect, it, vi } from 'vitest';

import {
  capHistory,
  CHARACTERS_PER_TOKEN,
  estimateTokens,
  MAX_HISTORY_TOKENS,
} from '../../src/rag/history.js';
import type { Turn } from '../../src/rag/llm-provider.js';
import { MAX_HISTORY_TURNS } from '../../src/rag/prompt.js';

/**
 * How much of a conversation reaches the prompt (P2-35).
 *
 * **Two controls in one number.** History is the largest variable part of a
 * prompt, so it is what the bill scales with — and every earlier turn is text a
 * visitor wrote, so it is attack surface that grows with the conversation. A
 * cap understood only as a cost control gets raised the first time somebody
 * wants better continuity.
 *
 * The case that decides whether this is right is the single enormous turn: six
 * turns is a count, and one turn can be most of a prompt.
 */

const turns = (count: number, content = 'ciao'): Turn[] =>
  Array.from({ length: count }, (_, at) => ({
    role: at % 2 === 0 ? ('user' as const) : ('assistant' as const),
    content: `${content} ${String(at)}`,
  }));

describe('the turn count', () => {
  it('keeps six of twenty', () => {
    expect(capHistory(turns(20)).turns).toHaveLength(MAX_HISTORY_TURNS);
  });

  it('keeps the recent six, not the first six', () => {
    /*
     * A conversation truncated from the recent end is a model answering the
     * opening of something it is being asked to continue — which reads as the
     * model having forgotten the last thing said to it.
     */
    const kept = capHistory(turns(20)).turns;

    expect(kept.at(-1)?.content).toBe('ciao 19');
    expect(kept.at(0)?.content).toBe('ciao 14');
  });

  it('keeps them oldest first, which is the order they happened in', () => {
    const kept = capHistory(turns(4)).turns;

    expect(kept.map((turn) => turn.content)).toEqual(['ciao 0', 'ciao 1', 'ciao 2', 'ciao 3']);
  });

  it('leaves a short conversation alone', () => {
    expect(capHistory(turns(3)).turns).toHaveLength(3);
  });

  it('handles an empty conversation', () => {
    expect(capHistory([])).toEqual({ turns: [], tokens: 0, dropped: 0 });
  });

  it('keeps nothing when the caller asks for nothing', () => {
    // A sweep asking "how does it answer with no history?" is a real question.
    expect(capHistory(turns(6), { maxTurns: 0 }).turns).toEqual([]);
  });
});

describe('the token ceiling', () => {
  it('cuts a single enormous turn down', () => {
    /*
     * **The case a turn count cannot catch.** Six turns is six whatever they
     * weigh, and one turn can be most of a prompt — so a count alone bounds the
     * wrong quantity, and the bill is the thing that finds out.
     */
    const huge = 'x'.repeat(MAX_HISTORY_TOKENS * CHARACTERS_PER_TOKEN * 2);

    expect(capHistory([{ role: 'user', content: huge }]).turns).toEqual([]);
  });

  it('keeps the recent turns that fit and drops the older ones', () => {
    const heavy = 'x'.repeat((MAX_HISTORY_TOKENS / 2) * CHARACTERS_PER_TOKEN);
    const history: Turn[] = [
      { role: 'user', content: heavy },
      { role: 'assistant', content: heavy },
      { role: 'user', content: heavy },
    ];

    const capped = capHistory(history);

    expect(capped.turns).toHaveLength(2);
    expect(capped.dropped).toBe(1);
  });

  it('never splits a message', () => {
    /*
     * A fragment is worse than an absence: the model reads it as a complete
     * thought, and a fragment of a visitor's message is exactly where an
     * injected instruction ends up looking like our own.
     */
    const content = 'x'.repeat(MAX_HISTORY_TOKENS * CHARACTERS_PER_TOKEN);
    const capped = capHistory([
      { role: 'user', content },
      { role: 'assistant', content },
    ]);

    for (const turn of capped.turns) expect(turn.content).toBe(content);
  });

  it('binds before the turn count when it is the tighter one', () => {
    const heavy = 'x'.repeat((MAX_HISTORY_TOKENS / 3) * CHARACTERS_PER_TOKEN);

    expect(capHistory(turns(6, heavy)).turns.length).toBeLessThan(MAX_HISTORY_TURNS);
  });

  it('uses the counter it is given, not always the estimate', () => {
    // A provider that offers a real counter is more accurate than four
    // characters a token, and the estimate exists only for the ones that do not.
    const countTokens = vi.fn(() => 1);

    const capped = capHistory(turns(4), { countTokens });

    expect(countTokens).toHaveBeenCalledTimes(4);
    expect(capped.tokens).toBe(4);
  });

  it('takes a ceiling from the caller, which is what lets P1-46 sweep it', () => {
    expect(capHistory(turns(6), { maxTokens: 1 }).turns).toEqual([]);
  });
});

describe('the estimate', () => {
  it('rounds up, so a turn is never counted as free', () => {
    expect(estimateTokens('abc')).toBe(1);
    expect(estimateTokens('')).toBe(0);
  });

  it('is conservative in the direction that costs a turn rather than a prompt', () => {
    /*
     * Four characters a token over-counts slightly for Italian and English
     * both, which trims a turn sooner than strictly needed and never overruns
     * the ceiling. Wrong the other way, the prompt is the thing that breaks.
     */
    expect(CHARACTERS_PER_TOKEN).toBeLessThanOrEqual(4);
  });
});

describe('what it reports', () => {
  it('says how many turns were left out', () => {
    expect(capHistory(turns(20)).dropped).toBe(14);
  });

  it('says what the history costs', () => {
    const capped = capHistory(turns(2));

    expect(capped.tokens).toBe(
      capped.turns.reduce((sum, turn) => sum + estimateTokens(turn.content), 0),
    );
  });
});
