import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  apply,
  asked,
  empty,
  isEmptyAnswer,
  lastQuestion,
  retried,
  stopped,
  type ChatFailure,
  type Conversation,
} from '../conversation.js';
import { failureOf } from '../send.js';
import type { StreamEvent } from '../sse.js';

/**
 * The chat (P3-06, §1.4, §1.7).
 *
 * **The stream is read here and reduced elsewhere.** What a visitor has read is
 * a value (`conversation.ts`); this owns the request, the abort and the DOM.
 * The split is what makes "an error preserves the conversation" a property with
 * a plain assertion behind it rather than a render to inspect.
 *
 * **Text nodes only.** Every string below is a JSX child, which Preact escapes
 * — the invariant is that nobody reaches for the escape hatch, and the P0-04
 * lint rule is what keeps it that way (§3.7, P3-08).
 *
 * **One live region, polite.** The answer arrives a few characters at a time,
 * so an assertive region would interrupt a screen reader on every delta and an
 * absent one would leave the answer unannounced entirely (§1.7).
 */

/** How a message is sent. Injected, so the component is testable without a network. */
export type Asker = (message: string, signal: AbortSignal) => AsyncIterable<StreamEvent>;

export interface ChatProps {
  readonly ask: Asker;
}

/**
 * Italian, inline, for exactly one row longer.
 *
 * P3-14 moves these behind a locale and P3-07 gives the five states their own
 * copy. What matters now is what §1.3 forbids and is already true here: no
 * plan, no counts, nothing about billing reaches a shopper.
 */
export const COPY = {
  label: 'Scrivi al sommelier',
  placeholder: 'Che vino mi consigli?',
  send: 'Invia',
  retry: 'Riprova',
  provider: 'Non riesco a rispondere in questo momento.',
  network: 'Connessione interrotta.',
  quota: 'Il sommelier si riposa. Torna presto!',
} as const;

const NOTICE: Record<ChatFailure, string> = {
  provider: COPY.provider,
  network: COPY.network,
  quota: COPY.quota,
};

/**
 * A retry is offered for what a retry can fix.
 *
 * The shop being busy and a connection that dropped are both worth another go.
 * A spent month is not, and a button that says otherwise wastes a visitor's
 * time to tell them the same thing again (§1.3).
 */
const isRetryable = (failure: ChatFailure): boolean => failure !== 'quota';

export const Chat = ({ ask }: ChatProps) => {
  const [conversation, setConversation] = useState<Conversation>(empty);
  const [draft, setDraft] = useState('');
  const flight = useRef<AbortController | undefined>(undefined);

  /*
   * **Unmount aborts the fetch**, and that is a cost control before it is
   * tidiness: the route passes the request's signal into generation (P2-29), so
   * an aborted request stops the model mid-token and stops the meter.
   *
   * Unmount, not close: §1.3 asks that a conversation survive in memory, so
   * `panel.close()` only hides it. What unmounts is the page going away, and
   * that is exactly when an answer nobody will read should stop being paid for.
   */
  useEffect(
    () => () => {
      flight.current?.abort();
    },
    [],
  );

  const run = useCallback(
    async (text: string, begin: (conversation: Conversation) => Conversation): Promise<void> => {
      /* A question asked while one is in flight replaces it rather than racing it. */
      flight.current?.abort();

      const controller = new AbortController();

      flight.current = controller;
      setConversation(begin);

      try {
        for await (const event of ask(text, controller.signal)) {
          if (controller.signal.aborted) return;

          setConversation((current) => apply(current, event));
        }

        /*
         * The loop ended without a `done` event, so the connection went away
         * mid-answer. Left alone the panel would sit there streaming forever,
         * which to a visitor is indistinguishable from a slow model.
         */
        setConversation((current) => (current.streaming ? stopped(current, 'network') : current));
      } catch (error) {
        /*
         * An abort is us, not a failure: the visitor asked for this to stop.
         *
         * **No test can currently tell.** The only abort today comes from
         * unmount, and a Preact state update on an unmounted component is a
         * no-op — mutation testing confirmed removing this line changes
         * nothing observable. It stays because it is the difference between
         * correct and accidentally harmless, and it becomes observable the
         * moment a second question can supersede one in flight.
         */
        if (controller.signal.aborted) return;

        setConversation((current) => stopped(current, failureOf(error)));
      }
    },
    [ask],
  );

  const submit = useCallback(
    (event: Event): void => {
      event.preventDefault();

      const text = draft.trim();

      if (text === '' || conversation.streaming) return;

      setDraft('');
      void run(text, (current) => asked(current, text));
    },
    [conversation.streaming, draft, run],
  );

  const retry = useCallback((): void => {
    const text = lastQuestion(conversation);

    if (text === undefined) return;

    void run(text, retried);
  }, [conversation, run]);

  const { failure } = conversation;

  return (
    <div class="chat">
      <div
        class="chat-log"
        role="log"
        aria-live="polite"
        aria-busy={conversation.streaming}
        data-testid="chat-log"
      >
        {conversation.turns.map((turn, index) =>
          isEmptyAnswer(turn) ? null : (
            /* Turns are only ever appended, so an index is a stable identity. */
            <div key={index} class={`turn turn-${turn.role}`}>
              <p class="turn-text">{turn.text}</p>
              {turn.recommendations.length > 0 && (
                <ul class="cards">
                  {turn.recommendations.map((item) => (
                    /*
                     * A placeholder card until P3-08. Only `reason` is model
                     * output and it is rendered as text; every other field a
                     * card will show comes from our own catalogue (P2-25).
                     */
                    <li key={item.productId} class="card" data-product-id={item.productId}>
                      {item.reason}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
      </div>

      {failure !== undefined && (
        <div class="notice" role="status">
          <span class="notice-text">{NOTICE[failure]}</span>
          {isRetryable(failure) && (
            <button type="button" class="notice-retry" onClick={retry}>
              {COPY.retry}
            </button>
          )}
        </div>
      )}

      <form class="composer" onSubmit={submit}>
        <label class="visually-hidden" for="chat-message">
          {COPY.label}
        </label>
        <input
          id="chat-message"
          class="composer-input"
          name="message"
          type="text"
          autocomplete="off"
          value={draft}
          placeholder={COPY.placeholder}
          disabled={conversation.streaming || failure === 'quota'}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
        <button
          type="submit"
          class="composer-send"
          disabled={conversation.streaming || failure === 'quota' || draft.trim() === ''}
        >
          {COPY.send}
        </button>
      </form>
    </div>
  );
};
