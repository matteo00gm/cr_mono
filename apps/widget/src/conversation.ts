import type { WidgetChatEvent } from '@catalogorosso/api-client';

import type { StreamEvent } from './sse.js';

/**
 * What a visitor has read so far (P3-06, §1.7).
 *
 * **A reducer, because a stream is a sequence of small facts.** Each event
 * changes one thing, and keeping that in a pure function is what makes "an
 * error mid-stream does not discard the conversation" a property with a test
 * rather than an intention.
 *
 * **Nothing here renders.** The component reads this; this knows nothing about
 * the DOM, which is what lets every case below be a plain assertion.
 */

/** A card the visitor may be shown. Only ids this request retrieved reach here (P2-25). */
export interface Recommendation {
  readonly productId: string;
  readonly reason: string;
  readonly confidence: number;
}

export interface Turn {
  readonly role: 'visitor' | 'sommelier';
  readonly text: string;
  readonly recommendations: readonly Recommendation[];
}

/**
 * Why an answer stopped, when it did.
 *
 * **Three, not one.** A visitor whose month is spent should not be told to try
 * again, and one whose network dropped should not be told the shop is busy —
 * the retry a widget offers is only useful if it is offered for the right
 * reason (§1.3).
 */
export type ChatFailure = 'provider' | 'quota' | 'network';

export interface Conversation {
  readonly turns: readonly Turn[];
  /** True while an answer is arriving. The composer is disabled and the log busy. */
  readonly streaming: boolean;
  /** Set when the last answer stopped early. Cleared by the next question. */
  readonly failure: ChatFailure | undefined;
}

export const empty: Conversation = { turns: [], streaming: false, failure: undefined };

/** The visitor's message, and the empty answer it is about to be given. */
export const asked = (conversation: Conversation, text: string): Conversation => ({
  turns: [
    ...conversation.turns,
    { role: 'visitor', text, recommendations: [] },
    { role: 'sommelier', text: '', recommendations: [] },
  ],
  streaming: true,
  /* A new question clears the last failure: the retry is this. */
  failure: undefined,
});

/** Replaces the answer being written, leaving everything before it alone. */
const amend = (conversation: Conversation, change: (turn: Turn) => Turn): Conversation => {
  const last = conversation.turns.at(-1);

  if (last?.role !== 'sommelier') return conversation;

  return { ...conversation, turns: [...conversation.turns.slice(0, -1), change(last)] };
};

/** The server's code, as one of the three things a visitor can usefully be told. */
type ErrorCode = Extract<WidgetChatEvent, { type: 'error' }>['code'];

const failureOf = (code: ErrorCode): ChatFailure =>
  code === 'quota_exceeded' ? 'quota' : 'provider';

/**
 * The answer stopped, for a reason the visitor is about to be given.
 *
 * **Everything read so far stays.** This is the same promise `apply` makes for
 * a mid-stream `error` event, and it has to hold for the other two ways an
 * answer ends badly too: a refusal before the first byte, and a connection that
 * went away in the middle.
 */
export const stopped = (conversation: Conversation, failure: ChatFailure): Conversation => ({
  ...conversation,
  streaming: false,
  failure,
});

/**
 * Applies one event.
 *
 * **An error never discards what has been read.** The row is explicit: a
 * failure mid-stream shows a retry *and preserves history*. A visitor who has
 * read three paragraphs and lost the fourth has still read three, and throwing
 * them away to render an error state is the widget punishing them for our
 * outage.
 */
export const apply = (conversation: Conversation, event: StreamEvent): Conversation => {
  if (event.type === 'text') {
    return amend(conversation, (turn) => ({ ...turn, text: turn.text + event.delta }));
  }

  if (event.type === 'recommendations') {
    return amend(conversation, (turn) => ({ ...turn, recommendations: event.items }));
  }

  if (event.type === 'error') return stopped(conversation, failureOf(event.code));

  return { ...conversation, streaming: false };
};

/**
 * The question to send again.
 *
 * Undefined when there is nothing to retry, which the component needs rather
 * than a guess: a retry button that resends the empty string is worse than no
 * retry button.
 */
export const lastQuestion = (conversation: Conversation): string | undefined =>
  conversation.turns.findLast((turn) => turn.role === 'visitor')?.text;

/**
 * Asking the last question again.
 *
 * **The failed answer is cleared, and nothing before it is.** The model starts
 * over, so keeping the half-written reply would show a visitor the first
 * paragraph twice — but the turns above it are a conversation they had, and a
 * retry is not a reason to lose it.
 */
export const retried = (conversation: Conversation): Conversation => ({
  ...amend(conversation, (turn) => ({ ...turn, text: '', recommendations: [] })),
  streaming: true,
  failure: undefined,
});

/** True when the answer being written is still blank, so there is no bubble worth showing. */
export const isEmptyAnswer = (turn: Turn): boolean =>
  turn.role === 'sommelier' && turn.text === '' && turn.recommendations.length === 0;
