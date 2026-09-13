import type { Turn } from '@catalogorosso/core';

/** One provider message: a role, and the texts it carries in order. */
export interface AlternatingTurn {
  readonly role: Turn['role'];
  readonly texts: readonly string[];
}

/**
 * History and the new prompt as strictly alternating turns, starting with the
 * user (P1-42, shared from P1-43).
 *
 * Bedrock refuses a conversation that starts with the assistant or repeats a
 * role, and history arriving from a widget session guarantees neither. So a
 * leading assistant turn is dropped, consecutive turns of one role are merged,
 * and the new prompt joins a trailing user turn rather than following it.
 * Every adapter sends this shape, so one history means the same thing to every
 * candidate in the bake-off.
 */
export const alternatingTurns = (history: readonly Turn[], user: string): AlternatingTurn[] => {
  const turns: { role: Turn['role']; texts: string[] }[] = [];

  const push = (role: Turn['role'], text: string): void => {
    const last = turns.at(-1);

    if (last?.role === role) {
      last.texts.push(text);
      return;
    }

    if (turns.length === 0 && role === 'assistant') return;

    turns.push({ role, texts: [text] });
  };

  for (const turn of history) push(turn.role, turn.content);
  push('user', user);

  return turns;
};
