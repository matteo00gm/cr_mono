import { useCallback, useEffect, useRef, useState } from 'preact/hooks';

import {
  apply,
  asked,
  empty,
  isEmptyAnswer,
  lastQuestion,
  retried,
  stopped,
  type Conversation,
} from '../conversation.js';
import type { Analytics } from '../analytics.js';
import type { CartPort } from '../cart/port.js';
import { useT } from '../i18n/useT.js';
import { failureOf, isLapsed } from '../send.js';
import type { StreamEvent } from '../sse.js';
import { acceptsQuestions, stateFor } from '../states.js';
import { CartButton } from './CartButton.js';
import { Notice } from './Notice.js';
import { ProductCard } from './ProductCard.js';

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
 *
 * **What is *not* working is one union** (P3-07). The notice, whether the
 * composer takes a question and whether a retry is offered all read from
 * `stateFor`, so a state added and not handled is a type error.
 */

/** How a message is sent. Injected, so the component is testable without a network. */
export type Asker = (message: string, signal: AbortSignal) => AsyncIterable<StreamEvent>;

export interface ChatProps {
  readonly ask: Asker;
  /** The tenant's own status, so a winery that lapses mid-session says so (§1.3). */
  readonly status?: 'ACTIVE' | 'DISABLED' | undefined;
  /** The storefront's cart, when it has one we can reach (§1.6). */
  readonly cart?: CartPort | undefined;
  /** The seller's configured cart path, validated before it is navigated to. */
  readonly cartUrl?: string | undefined;
  /** Injected by tests; the default moves the host page. */
  readonly navigate?: ((url: string) => void) | undefined;
  /**
   * Where the §Data Model events go (P3-20).
   *
   * Optional, and absent in most tests on purpose: analytics must never be the
   * thing that makes the chat work, so the component has to run without it.
   */
  readonly analytics?: Analytics | undefined;
}

export const Chat = ({ ask, status = 'ACTIVE', cart, cartUrl, navigate, analytics }: ChatProps) => {
  const t = useT();
  const [conversation, setConversation] = useState<Conversation>(empty);
  const [draft, setDraft] = useState('');
  /* Bumped after every add, which is what makes the badge refetch (P3-13). */
  const [added, setAdded] = useState(0);
  /*
   * **A winery can lapse while a shopper is mid-conversation** (P3-21). The
   * config said `ACTIVE` when the panel opened and the API is now answering
   * `unavailable`, so the state has to change under a panel that is already on
   * screen — and it has to change to *disabled*, not to an error with a retry
   * button that can never succeed (§1.3).
   */
  const [lapsed, setLapsed] = useState(false);
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

          /*
           * Recorded as the events arrive rather than at the end, because the
           * end is exactly what a visitor who closes the tab never reaches.
           */
          if (event.type === 'recommendations') {
            analytics?.record(event.items.length === 0 ? 'ZERO_RESULTS' : 'RECOMMENDATION_SHOWN');
          }

          setConversation((current) => apply(current, event));
        }

        /*
         * The loop ended without a `done` event, so the connection went away
         * mid-answer. Left alone the panel would sit there streaming forever,
         * which to a visitor is indistinguishable from a slow model.
         */
        setConversation((current) =>
          current.streaming ? stopped(current, { k: 'error', cause: 'network' }) : current,
        );
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

        if (isLapsed(error)) setLapsed(true);

        setConversation((current) => stopped(current, failureOf(error)));
      }
    },
    [ask],
  );

  const state = stateFor(lapsed ? 'DISABLED' : status, conversation.failure);
  const open = acceptsQuestions(state);

  const submit = useCallback(
    (event: Event): void => {
      event.preventDefault();

      const text = draft.trim();

      if (text === '' || conversation.streaming || !open) return;

      setDraft('');
      analytics?.record('MESSAGE_SENT');
      void run(text, (current) => asked(current, text));
    },
    [conversation.streaming, draft, open, run],
  );

  const addToCart = useCallback(
    async (item: { productId: string; variantId: string | null }): Promise<void> => {
      if (cart === undefined) return;

      await cart.add({ ...item, quantity: 1 });
      /* After the add, not before: an attempt that failed is not a sale. */
      analytics?.record('ADD_TO_CART', item.productId);
      setAdded((current) => current + 1);
    },
    [cart],
  );

  const retry = useCallback((): void => {
    const text = lastQuestion(conversation);

    if (text === undefined) return;

    void run(text, retried);
  }, [conversation, run]);

  return (
    <div class="chat">
      {cart !== undefined && cartUrl !== undefined && (
        <div class="chat-tools">
          <CartButton
            cart={cart}
            cartUrl={cartUrl}
            refreshKey={added}
            onOpen={() => {
              analytics?.record('CART_OPEN');
            }}
            {...(navigate === undefined ? {} : { navigate })}
          />
        </div>
      )}

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
                    <ProductCard
                      key={item.productId}
                      productId={item.productId}
                      reason={item.reason}
                      product={item.product}
                      variantId={item.product.variantId}
                      needsVariantId={cart?.needsVariantId ?? false}
                      onDetail={(id) => {
                        analytics?.record('PRODUCT_DETAIL_VIEW', id);
                      }}
                      {...(cart?.canAdd === true ? { onAdd: addToCart } : {})}
                    />
                  ))}
                </ul>
              )}
            </div>
          ),
        )}
      </div>

      <Notice state={state} onRetry={retry} />

      <form class="composer" onSubmit={submit}>
        <label class="visually-hidden" for="chat-message">
          {t('composerLabel')}
        </label>
        <input
          id="chat-message"
          class="composer-input"
          name="message"
          type="text"
          autocomplete="off"
          value={draft}
          placeholder={t('composerPlaceholder')}
          disabled={conversation.streaming || !open}
          onInput={(event) => {
            setDraft(event.currentTarget.value);
          }}
        />
        <button
          type="submit"
          class="composer-send"
          disabled={conversation.streaming || !open || draft.trim() === ''}
        >
          {t('send')}
        </button>
      </form>
    </div>
  );
};
