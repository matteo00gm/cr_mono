import { MAX_HISTORY_TURNS } from './prompt.js';

import type { Turn } from './llm-provider.js';

/**
 * How much of a conversation reaches the prompt (P2-35, §1.4).
 *
 * **Two controls in one number, and the comment has to say both.** History is
 * the largest variable part of a prompt, so it is what a bill scales with; and
 * every earlier turn is text a visitor wrote, so it is also attack surface that
 * grows with the conversation. A cap that was only about cost would be raised
 * the first time somebody wanted better continuity.
 *
 * **Oldest-first, and never mid-message.** A conversation truncated from the
 * recent end is a model answering the opening of something it is being asked to
 * continue. A message cut in half is worse than absent: the model reads a
 * fragment as a complete thought, and a fragment of a visitor's message is
 * exactly where an injected instruction ends up looking like our own.
 */

/**
 * The token ceiling for assembled history.
 *
 * **Whichever binds first**, this or the turn count. Six short turns cost
 * nothing and six long ones are most of a prompt, so a count alone bounds the
 * wrong quantity — and one enormous turn passes a count of six untouched.
 */
export const MAX_HISTORY_TOKENS = 1200;

/**
 * Characters per token, for the estimate used when a provider offers no counter.
 *
 * **Four, and deliberately conservative in the direction that costs money
 * rather than the one that breaks a prompt.** Italian tokenises a little worse
 * than English, so four over-counts slightly for both — which trims a turn
 * sooner than strictly needed and never overruns the ceiling. A tokeniser would
 * be a dependency and a version to keep aligned with a remote model, for a
 * bound that exists to be approximate.
 */
export const CHARACTERS_PER_TOKEN = 4;

/** What a turn costs, estimated. Exported so a caller can use the provider's counter instead. */
export const estimateTokens = (text: string): number =>
  Math.ceil(text.length / CHARACTERS_PER_TOKEN);

export interface HistoryLimits {
  readonly maxTurns?: number | undefined;
  readonly maxTokens?: number | undefined;
  /** The provider's own counter where it offers one; the estimate above otherwise. */
  readonly countTokens?: ((text: string) => number) | undefined;
}

export interface CappedHistory {
  /** What the prompt carries, oldest first. */
  readonly turns: readonly Turn[];
  /** What it costs, by whichever counter was used. */
  readonly tokens: number;
  /** How many turns were left out. Non-zero is ordinary; a jump is worth seeing. */
  readonly dropped: number;
}

/**
 * Takes the most recent turns that fit.
 *
 * **Both caps, and the tighter one decides.** The turn count is applied first
 * because it is the cheaper question, and then turns are added newest-first
 * until the next one would not fit — which is what makes the result whole
 * messages rather than a prefix of one.
 */
export const capHistory = (
  history: readonly Turn[],
  {
    maxTurns = MAX_HISTORY_TURNS,
    maxTokens = MAX_HISTORY_TOKENS,
    countTokens = estimateTokens,
  }: HistoryLimits = {},
): CappedHistory => {
  const recent = maxTurns <= 0 ? [] : history.slice(-maxTurns);

  const kept: Turn[] = [];
  let tokens = 0;

  /*
   * Newest first, so the ceiling drops the oldest — then reversed, because a
   * prompt reads in the order the conversation happened.
   */
  for (const turn of [...recent].reverse()) {
    const cost = countTokens(turn.content);

    if (tokens + cost > maxTokens) break;

    tokens += cost;
    kept.push(turn);
  }

  return { turns: kept.reverse(), tokens, dropped: history.length - kept.length };
};
