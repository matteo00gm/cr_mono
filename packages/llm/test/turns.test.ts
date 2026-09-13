import { describe, expect, it } from 'vitest';

import { alternatingTurns } from '../src/turns.js';

/** The history normalisation every adapter shares (P1-42, P1-43). */

describe('alternatingTurns', () => {
  it('drops a leading assistant turn, merges repeated roles, and joins the prompt to a trailing user turn', () => {
    expect(
      alternatingTurns(
        [
          { role: 'assistant', content: 'Benvenuto' },
          { role: 'user', content: 'Ciao' },
          { role: 'user', content: 'Mi serve un vino' },
          { role: 'assistant', content: 'Per cosa?' },
          { role: 'user', content: 'Brasato' },
        ],
        'PROMPT',
      ),
    ).toEqual([
      { role: 'user', texts: ['Ciao', 'Mi serve un vino'] },
      { role: 'assistant', texts: ['Per cosa?'] },
      { role: 'user', texts: ['Brasato', 'PROMPT'] },
    ]);
  });

  it('starts with the user when there is no history', () => {
    expect(alternatingTurns([], 'PROMPT')).toEqual([{ role: 'user', texts: ['PROMPT'] }]);
  });

  it('keeps the prompt as its own turn after an assistant turn', () => {
    expect(
      alternatingTurns(
        [
          { role: 'user', content: 'Ciao' },
          { role: 'assistant', content: 'Per cosa?' },
        ],
        'PROMPT',
      ).at(-1),
    ).toEqual({ role: 'user', texts: ['PROMPT'] });
  });
});
